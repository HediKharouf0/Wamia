#!/bin/bash
set -e

RPC="http://localhost:8545"
FIXTURE="fixtures/attack-transactions.json"

replay_wallet() {
  local KEY=$1
  local LABEL=$2

  COUNT=$(jq ".$KEY | length" $FIXTURE)
  echo "=== Replaying $COUNT $LABEL transactions ==="

  for i in $(seq 0 $(($COUNT - 1))); do
    TO=$(jq -r ".$KEY[$i].to" $FIXTURE)
    FROM=$(jq -r ".$KEY[$i].from" $FIXTURE)
    INPUT=$(jq -r ".$KEY[$i].input" $FIXTURE)
    TS=$(jq -r ".$KEY[$i].timeStamp" $FIXTURE)
    HASH=$(jq -r ".$KEY[$i].hash" $FIXTURE)

    echo "--- Tx $((i+1))/$COUNT: $HASH from $FROM -> $TO ---"
    cast rpc anvil_impersonateAccount $FROM --rpc-url $RPC > /dev/null
    cast rpc anvil_setBalance $FROM 0x56BC75E2D63100000 --rpc-url $RPC > /dev/null
    cast rpc evm_setNextBlockTimestamp $TS --rpc-url $RPC > /dev/null || true
    cast send $TO $INPUT --from $FROM --unlocked --rpc-url $RPC || echo "  (reverted or failed, continuing)"
    cast rpc anvil_stopImpersonatingAccount $FROM --rpc-url $RPC > /dev/null
  done
}

replay_wallet "manipulator" "manipulator"
replay_wallet "liquidator" "liquidator"

echo "=== Replay complete. Current block: ==="
cast block-number --rpc-url $RPC