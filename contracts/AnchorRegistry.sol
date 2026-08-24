// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Pacta AnchorRegistry
/// @notice Transparency log for the Pacta event log (Base Readiness, ADR-002).
/// Every ~12h the anchoring service publishes one Merkle root covering the log
/// entries in a time window. Roots live in events, never in storage: events are
/// far cheaper and permanently retrievable from logs, and nothing on-chain ever
/// needs to read an anchor. Only a monotonic `count` is stored, as the sequence.
///
/// A single authorized anchorer may write. This is honest: Pacta is the sole
/// writer of its own log. The security property is not access control - it is
/// that publication is irreversible. There is no proxy, no upgrade path, and no
/// owner beyond rotating the anchorer key via {setAnchorer}.
contract AnchorRegistry {
    /// @notice The only address allowed to call {anchor} and {setAnchorer}.
    address public anchorer;

    /// @notice Number of roots anchored so far; also the `sequence` of the next.
    uint256 public count;

    /// @notice Emitted once per anchored window.
    /// @param sequence   Zero-based index of this anchor (== `count` before ++).
    /// @param root       Merkle root over the window's entry hashes, or the
    ///                   zero root when the window is empty (leafCount == 0).
    /// @param windowStart Unix seconds (inclusive-exclusive lower bound) covered.
    /// @param windowEnd   Unix seconds upper bound of the window covered.
    /// @param leafCount   Number of log entries in the window (0 is valid).
    event RootAnchored(
        uint256 indexed sequence,
        bytes32 indexed root,
        uint64 windowStart,
        uint64 windowEnd,
        uint32 leafCount
    );

    error NotAnchorer();

    constructor(address _anchorer) {
        anchorer = _anchorer;
    }

    /// @notice Publish one Merkle root. Always emits, including for empty
    /// windows (leafCount == 0), so a gap in the sequence is itself an alarm.
    function anchor(
        bytes32 root,
        uint64 windowStart,
        uint64 windowEnd,
        uint32 leafCount
    ) external {
        if (msg.sender != anchorer) revert NotAnchorer();
        emit RootAnchored(count, root, windowStart, windowEnd, leafCount);
        unchecked { ++count; }
    }

    /// @notice Rotate the anchorer key. The only privileged operation.
    function setAnchorer(address next) external {
        if (msg.sender != anchorer) revert NotAnchorer();
        anchorer = next;
    }
}
