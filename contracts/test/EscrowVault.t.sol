// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Security regression tests for EscrowVault, run on a real EVM with `forge test`.
// They model the THREE exact attacks Aria-2 confirmed against the first version
// and assert the fixes hold, plus the happy-path and dispute-path end to end.
//
// Self-contained: a minimal Vm cheatcode interface (no forge-std to install) and
// a mock USDC. Run:  forge test -vv   (see packages/settlement-base/README.md).

import {EscrowVault, IERC20} from "../EscrowVault.sol";

interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address) external;
    function expectRevert(bytes4 selector) external;
    function label(address, string calldata) external;
}

contract MockUSDC {
    string public constant name = "USD Coin";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract EscrowVaultSecurityTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    EscrowVault vault;
    MockUSDC usdc;

    // actors
    uint256 constant BUYER_PK = 0xB0;
    uint256 constant PROVIDER_PK = 0xB1; // the victim in Critical #1
    uint256 constant ARBITER_PK = 0xB2;
    uint256 constant ATTACKER_PK = 0xBAD;
    address buyer;
    address provider;
    address arbiter;
    address attacker;
    address guardian = address(0x6);
    address RELAYER = address(0x7);

    uint256 constant PRICE = 1_000e6; // 1000 USDC engagement price
    uint256 constant STAKE = 5_000e6; // provider collateral
    bytes32 constant AH = keccak256("agreement-1");

    bytes32 constant OPEN_TYPEHASH = keccak256(
        "OpenEngagement(bytes32 agreementHash,address buyer,address provider,address arbiter,address token,uint256 amount)"
    );
    bytes32 constant SETTLE_TYPEHASH =
        keccak256("Settlement(bytes32 agreementHash,uint8 outcome,uint256 buyerAmount,uint256 providerAmount)");
    bytes32 constant SLASH_TYPEHASH = keccak256("Slash(bytes32 agreementHash,uint8 outcome)");

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        provider = vm.addr(PROVIDER_PK);
        arbiter = vm.addr(ARBITER_PK);
        attacker = vm.addr(ATTACKER_PK);
        usdc = new MockUSDC();
        vault = new EscrowVault(IERC20(address(usdc)), guardian, 1_000_000e6);
        // fund actors and pre-approve the vault
        usdc.mint(buyer, 10_000e6);
        usdc.mint(provider, 10_000e6);
        usdc.mint(attacker, 10_000e6);
        vm.prank(buyer);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(provider);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ---- digest helpers (match EscrowVault.sol) -------------------------------
    function _typed(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
    }

    function _openDigest(bytes32 ah, address b, address p, address a, uint256 amount) internal view returns (bytes32) {
        return _typed(keccak256(abi.encode(OPEN_TYPEHASH, ah, b, p, a, address(usdc), amount)));
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _slashDigest(bytes32 ah, uint8 outcome) internal view returns (bytes32) {
        return _typed(keccak256(abi.encode(SLASH_TYPEHASH, ah, outcome)));
    }

    function _settleDigest(bytes32 ah, uint8 o, uint256 ba, uint256 pa) internal view returns (bytes32) {
        return _typed(keccak256(abi.encode(SETTLE_TYPEHASH, ah, o, ba, pa)));
    }

    function _openLegit() internal {
        bytes32 d = _openDigest(AH, buyer, provider, arbiter, PRICE);
        vm.prank(RELAYER);
        vault.openEngagement(AH, buyer, provider, arbiter, PRICE, _sig(BUYER_PK, d), _sig(PROVIDER_PK, d));
    }

    function _depositProviderStake() internal {
        vm.prank(provider);
        vault.depositCollateral(provider, STAKE);
    }

    // ---- CRITICAL #1: collateral theft without provider consent ---------------
    function test_Critical1_cannotOpenBindingVictimWithoutProviderSig() public {
        _depositProviderStake();
        require(vault.collateralOf(provider) == STAKE, "stake");

        // Attacker tries to open a junk engagement naming the victim as provider
        // and itself as arbiter+buyer, signing the "provider" slot itself.
        bytes32 junk = keccak256("junk");
        bytes32 d = _openDigest(junk, attacker, provider, attacker, PRICE);
        vm.expectRevert(EscrowVault.BadSignature.selector);
        vm.prank(attacker);
        vault.openEngagement(junk, attacker, provider, attacker, PRICE, _sig(ATTACKER_PK, d), _sig(ATTACKER_PK, d));

        // Victim collateral is untouched; there is no engagement to slash.
        require(vault.collateralOf(provider) == STAKE, "victim collateral drained");
    }

    // ---- CRITICAL #2: slash replay --------------------------------------------
    function test_Critical2_slashCannotBeReplayed() public {
        _depositProviderStake();
        _openLegit();

        uint8 refund = vault.OUTCOME_REFUND(); // read the view BEFORE expectRevert
        bytes memory arbSig = _sig(ARBITER_PK, _slashDigest(AH, refund));
        bytes memory empty = "";

        // First (legitimate) slash: 20% of 1000 = 200 USDC.
        vault.slashCollateral(AH, refund, arbSig, empty);
        require(vault.collateralOf(provider) == STAKE - 200e6, "first slash amount");

        // Replaying the SAME signature must revert — not drain 5x.
        vm.expectRevert(EscrowVault.AlreadySlashed.selector);
        vault.slashCollateral(AH, refund, arbSig, empty);
        require(vault.collateralOf(provider) == STAKE - 200e6, "collateral drained by replay");
    }

    // ---- MEDIUM: slash evasion via withdrawal ---------------------------------
    function test_Medium_providerCannotWithdrawLockedCollateral() public {
        _depositProviderStake();
        _openLegit(); // reserves 20% of PRICE = 200 USDC

        require(vault.lockedCollateral(provider) == 200e6, "reserve");
        require(vault.freeCollateralOf(provider) == STAKE - 200e6, "free");

        // Cannot withdraw the whole balance — the pending slash is reserved.
        vm.expectRevert(EscrowVault.CollateralLocked.selector);
        vm.prank(provider);
        vault.withdrawCollateral(STAKE);

        // Can withdraw exactly the free portion.
        vm.prank(provider);
        vault.withdrawCollateral(STAKE - 200e6);
        require(vault.collateralOf(provider) == 200e6, "free withdrawn");

        // The reserved 200 is still slashable by the arbiter.
        vault.slashCollateral(AH, vault.OUTCOME_REFUND(), _sig(ARBITER_PK, _slashDigest(AH, vault.OUTCOME_REFUND())), "");
        require(vault.collateralOf(provider) == 0, "reserved slashed");
    }

    // ---- happy path: open -> fund -> settle(release) --------------------------
    function test_HappyPath_releaseFreesTheLock() public {
        _depositProviderStake();
        _openLegit();
        vm.prank(buyer);
        vault.fund(AH, PRICE);
        require(vault.escrowBalance(AH) == PRICE, "funded");

        uint256 provBefore = usdc.balanceOf(provider);
        bytes32 d = _settleDigest(AH, vault.OUTCOME_RELEASE(), 0, PRICE);
        vault.settle(AH, vault.OUTCOME_RELEASE(), 0, PRICE, _sig(ARBITER_PK, d), "");
        require(usdc.balanceOf(provider) == provBefore + PRICE, "released to provider");

        // Release means no slash: the reservation is freed, full collateral is
        // withdrawable again.
        require(vault.lockedCollateral(provider) == 0, "lock freed");
        vm.prank(provider);
        vault.withdrawCollateral(STAKE);
        require(vault.collateralOf(provider) == 0, "all free after release");
    }

    // ---- dispute path: open -> fund -> settle(refund) + slash ------------------
    function test_DisputePath_refundAndSlash() public {
        _depositProviderStake();
        _openLegit();
        vm.prank(buyer);
        vault.fund(AH, PRICE);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        // refund escrow to buyer (both parties authorize)
        bytes32 sdg = _settleDigest(AH, vault.OUTCOME_REFUND(), PRICE, 0);
        vault.settle(AH, vault.OUTCOME_REFUND(), PRICE, 0, _sig(BUYER_PK, sdg), _sig(PROVIDER_PK, sdg));
        require(usdc.balanceOf(buyer) == buyerBefore + PRICE, "refunded to buyer");

        // slash 20% of price to buyer
        uint256 buyerMid = usdc.balanceOf(buyer);
        vault.slashCollateral(AH, vault.OUTCOME_REFUND(), _sig(ARBITER_PK, _slashDigest(AH, vault.OUTCOME_REFUND())), "");
        require(vault.collateralOf(provider) == STAKE - 200e6, "slashed 20%");
        require(usdc.balanceOf(buyer) == buyerMid + 200e6, "slash paid to buyer");
    }
}
