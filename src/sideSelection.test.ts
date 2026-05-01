import assert from "node:assert/strict";
import test from "node:test";

import { selectSideForRule } from "./sideSelection.js";

test("selects YES when only YES is in range", () => {
  const result = selectSideForRule({
    yesAsk: 0.95,
    noAsk: 0.72,
    minPrice: 0.9,
    maxPrice: 0.99,
    mode: "RANGE_DRIVEN",
    bothSidesPolicy: "SKIP",
  });

  assert.equal(result.selectedSide, "YES");
  assert.equal(result.selectedPrice, 0.95);
  assert.equal(result.reason, "yes_only_in_range");
});

test("selects NO when only NO is in range", () => {
  const result = selectSideForRule({
    yesAsk: 0.62,
    noAsk: 0.94,
    minPrice: 0.9,
    maxPrice: 0.99,
    mode: "RANGE_DRIVEN",
    bothSidesPolicy: "SKIP",
  });

  assert.equal(result.selectedSide, "NO");
  assert.equal(result.selectedPrice, 0.94);
  assert.equal(result.reason, "no_only_in_range");
});

test("returns no side when both sides in range and policy is SKIP", () => {
  const result = selectSideForRule({
    yesAsk: 0.94,
    noAsk: 0.95,
    minPrice: 0.9,
    maxPrice: 0.99,
    mode: "RANGE_DRIVEN",
    bothSidesPolicy: "SKIP",
  });

  assert.equal(result.selectedSide, null);
  assert.equal(result.selectedPrice, null);
  assert.equal(result.reason, "both_in_range_policy_skip");
});

test("uses LOWER_PRICE policy when both sides are in range", () => {
  const result = selectSideForRule({
    yesAsk: 0.93,
    noAsk: 0.96,
    minPrice: 0.9,
    maxPrice: 0.99,
    mode: "RANGE_DRIVEN",
    bothSidesPolicy: "LOWER_PRICE",
  });

  assert.equal(result.selectedSide, "YES");
  assert.equal(result.selectedPrice, 0.93);
  assert.equal(result.reason, "both_in_range_policy_lower_price");
});

test("returns no side when neither side is in range", () => {
  const result = selectSideForRule({
    yesAsk: 0.45,
    noAsk: 0.55,
    minPrice: 0.9,
    maxPrice: 0.99,
    mode: "RANGE_DRIVEN",
    bothSidesPolicy: "YES",
  });

  assert.equal(result.selectedSide, null);
  assert.equal(result.selectedPrice, null);
  assert.equal(result.reason, "neither_side_in_range");
});

test("legacy mode picks highest ask if in range", () => {
  const result = selectSideForRule({
    yesAsk: 0.97,
    noAsk: 0.92,
    minPrice: 0.9,
    maxPrice: 0.99,
    mode: "LEGACY_HIGHEST_ASK",
    bothSidesPolicy: "SKIP",
  });

  assert.equal(result.selectedSide, "YES");
  assert.equal(result.selectedPrice, 0.97);
  assert.equal(result.reason, "legacy_highest_ask_selected");
});

test("legacy mode returns no side when highest ask is out of range", () => {
  const result = selectSideForRule({
    yesAsk: 0.99,
    noAsk: 0.98,
    minPrice: 0.9,
    maxPrice: 0.95,
    mode: "LEGACY_HIGHEST_ASK",
    bothSidesPolicy: "SKIP",
  });

  assert.equal(result.selectedSide, null);
  assert.equal(result.selectedPrice, null);
  assert.equal(result.reason, "legacy_side_out_of_range");
});
