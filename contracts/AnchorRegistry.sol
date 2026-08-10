// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Event-only anchor registry for the Pacta event log (ADR-001, Phase 0).
/// Deliberately permissionless and minimal: anyone may call, verifiers filter
/// by sender. No owner, no pause, no upgrade, no storage, no funds — a
/// receipts-trie commitment is equally immutable at a fraction of the gas,
/// and nothing on-chain ever needs to read an anchor.
contract AnchorRegistry {
    event Anchored(bytes32 indexed root, uint64 fromSeq, uint64 toSeq, address indexed sender);

    function anchor(bytes32 root, uint64 fromSeq, uint64 toSeq) external {
        emit Anchored(root, fromSeq, toSeq, msg.sender);
    }
}
