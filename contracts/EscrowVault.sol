// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Pacta EscrowVault — the reference on-chain settlement backend for the Pacta
// protocol (Base Readiness Spec, "P1 · EscrowVault on Base").
//
// ONE vault holds USDC for EVERY engagement. Engagements are keyed by the
// agreement_hash (the SHA-256 identity of the RFC-8785 canonicalized agreement,
// as bytes32). Buyer funds are accounted per engagement and can never move
// between engagements. Provider collateral lives in the same vault under a
// separate per-provider balance.
//
// The contract does NOT trust its caller to assert an outcome. Settlement runs
// only against EIP-712 secp256k1 signatures (ecrecover) bound to the
// agreement_hash: either BOTH parties (mutual settlement) or the designated
// arbiter alone (dispute ruling). The buyer/provider/arbiter addresses are
// fixed when the engagement is opened and are immutable afterward. They must
// equal the three addresses carried inside the canonicalized agreement — and
// therefore inside the agreement_hash itself — so that whoever controls address
// assignment does NOT control settlement (see the adapter README, "Address
// binding"). The open call is authenticated by BOTH the buyer's and the
// provider's EIP-712 signatures over the exact address set: the provider's
// collateral is at stake, so it must consent to being bound to this engagement
// and to this arbiter. Requiring only the buyer would let a griefer open a junk
// engagement naming a victim as provider and itself as arbiter, then "rule" a
// slash and drain the victim's collateral. Opening also reserves the provider's
// maximum slash exposure so it cannot be withdrawn while a slash is pending, and
// each engagement can be slashed at most once (replay guard).
//
// Slashing runs in code, matching the protocol's dispute rules: an adverse
// ruling takes 20% of the engagement price from provider collateral on a full
// refund, 10% on a split, paid to the buyer. WebAuthn/passkey (P-256)
// signatures are NOT verifiable here; passkey parties map to the vault through
// the disclosed custodial secp256k1 fallback (Phase 0 plan, PA-2).
//
// Deliberately OUT of scope (rejected in the architecture decision): on-chain
// lifecycle micro-states, evidence/KYB/terms text on-chain (only hashes),
// oracles, per-deal contract deployment, any bespoke token. Escrow and
// collateral settle in Circle USDC. No proxy, no upgradeability: a minimal
// guardian can pause and set the TVL cap; that is the whole admin surface.
// This is unaudited testnet code — the TVL cap and pause are what make shipping
// it responsible rather than reckless.

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract EscrowVault {
    // ---- immutables -----------------------------------------------------------
    IERC20 public immutable usdc;
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ---- settlement outcomes --------------------------------------------------
    uint8 public constant OUTCOME_RELEASE = 1; // full escrow to provider
    uint8 public constant OUTCOME_REFUND = 2; // full escrow to buyer
    uint8 public constant OUTCOME_SPLIT = 3; // escrow split buyer/provider

    // Slashing percentages of the engagement price (== funded escrow), matching
    // the protocol's versioned dispute rules. Kept in the contract so the code,
    // not a caller, decides the penalty.
    uint256 public constant SLASH_REFUND_PCT = 20;
    uint256 public constant SLASH_SPLIT_PCT = 10;

    // ---- admin ----------------------------------------------------------------
    address public guardian;
    bool public paused;
    uint256 public tvlCap; // max USDC this vault will ever custody
    uint256 public totalLocked; // escrow held + collateral held

    // ---- per-engagement + per-provider state ----------------------------------
    struct Engagement {
        address buyer;
        address provider;
        address arbiter;
        uint256 price; // engagement price bound at open; the slashing base
        uint256 funded; // USDC currently escrowed for this engagement
        uint256 locked; // provider collateral reserved against this engagement's slash
        bool opened;
        bool settled;
        bool slashed; // one slash per engagement (replay guard)
    }

    mapping(bytes32 => Engagement) public engagements;
    mapping(address => uint256) public collateral;
    // Provider collateral reserved against open, not-yet-resolved engagements so
    // it cannot be withdrawn out from under a pending slash. Sum of each open
    // engagement's `locked` for that provider.
    mapping(address => uint256) public lockedCollateral;

    // ---- events ---------------------------------------------------------------
    event EngagementOpened(
        bytes32 indexed agreementHash, address buyer, address provider, address arbiter
    );
    event Funded(bytes32 indexed agreementHash, address indexed from, uint256 amount, uint256 funded);
    event Settled(bytes32 indexed agreementHash, uint8 outcome, uint256 buyerAmount, uint256 providerAmount);
    event Slashed(
        bytes32 indexed agreementHash, address indexed provider, address indexed beneficiary, uint256 amount
    );
    event CollateralDeposited(address indexed provider, address indexed from, uint256 amount);
    event CollateralWithdrawn(address indexed provider, uint256 amount);
    event PausedSet(bool paused);
    event TvlCapSet(uint256 cap);
    event GuardianTransferred(address indexed from, address indexed to);

    // ---- errors ---------------------------------------------------------------
    error NotGuardian();
    error IsPaused();
    error CapExceeded();
    error AlreadyOpened();
    error NotOpened();
    error AlreadySettled();
    error AlreadySlashed();
    error CollateralLocked();
    error BadSignature();
    error BadAmounts();
    error TransferFailed();
    error ZeroAddress();
    error Reentrancy();

    // EIP-712 typehashes. The domain is vault-specific (name "PactaEscrowVault",
    // includes verifyingContract) and distinct from the Phase 0 "Pacta" agreement
    // domain: an "I agree to the terms" signature can never be replayed as a
    // settlement authorization.
    bytes32 private constant OPEN_TYPEHASH = keccak256(
        "OpenEngagement(bytes32 agreementHash,address buyer,address provider,address arbiter,address token,uint256 amount)"
    );
    bytes32 private constant SETTLE_TYPEHASH = keccak256(
        "Settlement(bytes32 agreementHash,uint8 outcome,uint256 buyerAmount,uint256 providerAmount)"
    );
    bytes32 private constant SLASH_TYPEHASH = keccak256("Slash(bytes32 agreementHash,uint8 outcome)");

    // secp256k1 n/2 — reject high-s (malleable) signatures. @noble produces
    // canonical low-s signatures, so honest Pacta signatures always pass.
    uint256 private constant HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 private _guard = 1;

    constructor(IERC20 _usdc, address _guardian, uint256 _tvlCap) {
        if (address(_usdc) == address(0) || _guardian == address(0)) revert ZeroAddress();
        usdc = _usdc;
        guardian = _guardian;
        tvlCap = _tvlCap;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("PactaEscrowVault")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        emit TvlCapSet(_tvlCap);
        emit GuardianTransferred(address(0), _guardian);
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier notPaused() {
        if (paused) revert IsPaused();
        _;
    }

    modifier nonReentrant() {
        if (_guard != 1) revert Reentrancy();
        _guard = 2;
        _;
        _guard = 1;
    }

    // ---- open -----------------------------------------------------------------
    // Bind the buyer/provider/arbiter address set to the agreement_hash. BOTH the
    // buyer and the provider must sign the exact address set — the provider's
    // collateral is at stake, so it must consent to being bound to this
    // engagement and to THIS arbiter. Without the provider signature an attacker
    // could open a junk engagement naming a victim as provider and itself as
    // arbiter, then "rule" a slash and drain the victim's collateral. Both
    // signatures mirror the dual-signed agreement whose hash is agreementHash;
    // off-chain anyone can confirm these addresses equal the ones inside it.
    //
    // Opening also reserves the provider's maximum slash exposure for this
    // engagement (SLASH_REFUND_PCT of the price) so it cannot be withdrawn while
    // a slash is pending.
    function openEngagement(
        bytes32 agreementHash,
        address buyer,
        address provider,
        address arbiter,
        uint256 amount,
        bytes calldata buyerSig,
        bytes calldata providerSig
    ) external notPaused {
        if (buyer == address(0) || provider == address(0)) revert ZeroAddress();
        Engagement storage e = engagements[agreementHash];
        if (e.opened) revert AlreadyOpened();
        bytes32 digest = _hashTyped(
            keccak256(abi.encode(OPEN_TYPEHASH, agreementHash, buyer, provider, arbiter, address(usdc), amount))
        );
        if (_recover(digest, buyerSig) != buyer) revert BadSignature();
        if (_recover(digest, providerSig) != provider) revert BadSignature();
        e.buyer = buyer;
        e.provider = provider;
        e.arbiter = arbiter;
        e.price = amount;
        e.opened = true;
        uint256 reserve = (amount * SLASH_REFUND_PCT) / 100;
        e.locked = reserve;
        lockedCollateral[provider] += reserve;
        emit EngagementOpened(agreementHash, buyer, provider, arbiter);
    }

    // ---- fund -----------------------------------------------------------------
    // Buyer moves USDC into the engagement escrow (approve the vault first).
    // Funds are per-engagement; nothing here can spend another engagement's money.
    function fund(bytes32 agreementHash, uint256 amount) external notPaused nonReentrant {
        Engagement storage e = engagements[agreementHash];
        if (!e.opened) revert NotOpened();
        if (e.settled) revert AlreadySettled();
        if (amount == 0) revert BadAmounts();
        _lock(amount);
        e.funded += amount;
        _pull(msg.sender, amount);
        emit Funded(agreementHash, msg.sender, amount, e.funded);
    }

    // ---- settle ---------------------------------------------------------------
    // Distribute the escrow for `agreementHash` according to `outcome`, but only
    // if the signatures authorize it: both parties, or the arbiter alone. Escrow
    // distribution and collateral slashing are separate authorized operations
    // (see slashCollateral), mirroring the ledger backend's split-then-slash flow.
    function settle(
        bytes32 agreementHash,
        uint8 outcome,
        uint256 buyerAmount,
        uint256 providerAmount,
        bytes calldata sigA,
        bytes calldata sigB
    ) external notPaused nonReentrant {
        Engagement storage e = engagements[agreementHash];
        if (!e.opened) revert NotOpened();
        if (e.settled) revert AlreadySettled();

        uint256 funded = e.funded;
        if (outcome == OUTCOME_RELEASE) {
            if (buyerAmount != 0 || providerAmount != funded) revert BadAmounts();
        } else if (outcome == OUTCOME_REFUND) {
            if (providerAmount != 0 || buyerAmount != funded) revert BadAmounts();
        } else if (outcome == OUTCOME_SPLIT) {
            if (buyerAmount + providerAmount != funded) revert BadAmounts();
        } else {
            revert BadAmounts();
        }

        bytes32 digest = _hashTyped(
            keccak256(abi.encode(SETTLE_TYPEHASH, agreementHash, outcome, buyerAmount, providerAmount))
        );
        if (!_authorized(e, digest, sigA, sigB)) revert BadSignature();

        // Effects before interactions: mark settled and clear escrow first.
        e.settled = true;
        e.funded = 0;
        _unlock(funded);
        // A release ruling means no dispute, so no slash is coming: free the
        // provider's reserved collateral now. Refund/split keep the reserve until
        // slashCollateral consumes it, so the provider can't front-run the slash.
        if (outcome == OUTCOME_RELEASE) _releaseCollateralLock(e);
        if (buyerAmount > 0) _push(e.buyer, buyerAmount);
        if (providerAmount > 0) _push(e.provider, providerAmount);
        emit Settled(agreementHash, outcome, buyerAmount, providerAmount);
    }

    // ---- slash ----------------------------------------------------------------
    // Take provider collateral to the buyer on an adverse ruling. The penalty is
    // decided by the code, not the caller: SLASH_REFUND_PCT of the engagement
    // price on a refund, SLASH_SPLIT_PCT on a split, capped at the provider's
    // free collateral. Authorized like settle: the arbiter alone, or both
    // parties. Escrow settlement (settle) and this are separate authorized
    // operations, mirroring the ledger backend's split-then-slash flow.
    function slashCollateral(bytes32 agreementHash, uint8 outcome, bytes calldata sigA, bytes calldata sigB)
        external
        notPaused
        nonReentrant
    {
        Engagement storage e = engagements[agreementHash];
        if (!e.opened) revert NotOpened();
        // One slash per engagement. The Slash digest has no nonce and is constant,
        // so without this guard a single legitimate signature could be replayed
        // until the provider's collateral is drained.
        if (e.slashed) revert AlreadySlashed();
        uint256 pct = outcome == OUTCOME_REFUND ? SLASH_REFUND_PCT : (outcome == OUTCOME_SPLIT ? SLASH_SPLIT_PCT : 0);
        if (pct == 0) revert BadAmounts();

        bytes32 digest = _hashTyped(keccak256(abi.encode(SLASH_TYPEHASH, agreementHash, outcome)));
        if (!_authorized(e, digest, sigA, sigB)) revert BadSignature();

        // Effects before interactions: consume the one-shot and release the
        // reservation first.
        e.slashed = true;
        _releaseCollateralLock(e);
        uint256 penalty = (e.price * pct) / 100;
        uint256 bal = collateral[e.provider];
        if (penalty > bal) penalty = bal;
        if (penalty > 0) {
            collateral[e.provider] = bal - penalty;
            _unlock(penalty);
            _push(e.buyer, penalty);
        }
        // Always emit (even a zero penalty) so the ledger's "capped slash returns
        // the amount actually taken" semantics are observable on-chain.
        emit Slashed(agreementHash, e.provider, e.buyer, penalty);
    }

    // ---- collateral -----------------------------------------------------------
    // Anyone may top up a provider's collateral (approve the vault first); the
    // balance is credited to `provider`, not to the payer.
    function depositCollateral(address provider, uint256 amount) external notPaused nonReentrant {
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert BadAmounts();
        _lock(amount);
        collateral[provider] += amount;
        _pull(msg.sender, amount);
        emit CollateralDeposited(provider, msg.sender, amount);
    }

    // A provider withdraws its FREE collateral — the balance minus what is
    // reserved against open, not-yet-resolved engagements. This is what stops a
    // provider from front-running a pending slash by withdrawing first. Also
    // gated by the pause. Slashing is the only other way collateral leaves.
    function withdrawCollateral(uint256 amount) external notPaused nonReentrant {
        uint256 bal = collateral[msg.sender];
        uint256 locked = lockedCollateral[msg.sender];
        uint256 free = bal > locked ? bal - locked : 0;
        if (amount == 0 || amount > free) revert CollateralLocked();
        collateral[msg.sender] = bal - amount;
        _unlock(amount);
        _push(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    // ---- views ----------------------------------------------------------------
    function escrowBalance(bytes32 agreementHash) external view returns (uint256) {
        return engagements[agreementHash].funded;
    }

    function collateralOf(address provider) external view returns (uint256) {
        return collateral[provider];
    }

    // Provider collateral that can be withdrawn right now (balance minus reserved).
    function freeCollateralOf(address provider) external view returns (uint256) {
        uint256 bal = collateral[provider];
        uint256 locked = lockedCollateral[provider];
        return bal > locked ? bal - locked : 0;
    }

    // ---- admin (minimal guardian, no proxy, no upgradeability) ----------------
    function setPaused(bool p) external onlyGuardian {
        paused = p;
        emit PausedSet(p);
    }

    function setTvlCap(uint256 cap) external onlyGuardian {
        tvlCap = cap;
        emit TvlCapSet(cap);
    }

    function transferGuardian(address next) external onlyGuardian {
        if (next == address(0)) revert ZeroAddress();
        emit GuardianTransferred(guardian, next);
        guardian = next;
    }

    // ---- internal -------------------------------------------------------------
    function _authorized(Engagement storage e, bytes32 digest, bytes calldata sigA, bytes calldata sigB)
        internal
        view
        returns (bool)
    {
        address a = _recover(digest, sigA);
        if (a != address(0) && a == e.arbiter) return true;
        address b = _recover(digest, sigB);
        if ((a == e.buyer && b == e.provider) || (a == e.provider && b == e.buyer)) {
            return a != address(0) && b != address(0);
        }
        return false;
    }

    // Release an engagement's provider-collateral reservation exactly once.
    function _releaseCollateralLock(Engagement storage e) internal {
        uint256 reserve = e.locked;
        if (reserve > 0) {
            e.locked = 0;
            uint256 pl = lockedCollateral[e.provider];
            lockedCollateral[e.provider] = pl > reserve ? pl - reserve : 0;
        }
    }

    function _lock(uint256 amount) internal {
        uint256 t = totalLocked + amount;
        if (t > tvlCap) revert CapExceeded();
        totalLocked = t;
    }

    function _unlock(uint256 amount) internal {
        totalLocked -= amount;
    }

    function _pull(address from, uint256 amount) internal {
        if (!usdc.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }

    function _hashTyped(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > HALF_N) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
