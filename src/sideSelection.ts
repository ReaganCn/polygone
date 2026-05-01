/**
 * sideSelection.ts
 *
 * Pure side-selection helpers used by scanner.ts.
 */

export type Side = "YES" | "NO";
export type SideSelectionMode = "RANGE_DRIVEN" | "LEGACY_HIGHEST_ASK";
export type BothSidesInRangePolicy = "SKIP" | "YES" | "NO" | "LOWER_PRICE" | "HIGHER_PRICE";

export interface SideSelectionInput {
  yesAsk: number;
  noAsk: number;
  minPrice: number;
  maxPrice: number;
  mode: SideSelectionMode;
  bothSidesPolicy: BothSidesInRangePolicy;
}

export interface SideSelectionEvaluation {
  yesInRange: boolean;
  noInRange: boolean;
  selectedSide: Side | null;
  selectedPrice: number | null;
  reason: string;
  policyApplied: BothSidesInRangePolicy | "LEGACY_HIGHEST_ASK" | null;
}

export function selectSideForRule(input: SideSelectionInput): SideSelectionEvaluation {
  const yesInRange = inRange(input.yesAsk, input.minPrice, input.maxPrice);
  const noInRange = inRange(input.noAsk, input.minPrice, input.maxPrice);

  if (input.mode === "LEGACY_HIGHEST_ASK") {
    const selectedSide: Side = input.yesAsk >= input.noAsk ? "YES" : "NO";
    const selectedPrice = selectedSide === "YES" ? input.yesAsk : input.noAsk;

    if (!inRange(selectedPrice, input.minPrice, input.maxPrice)) {
      return {
        yesInRange,
        noInRange,
        selectedSide: null,
        selectedPrice: null,
        reason: "legacy_side_out_of_range",
        policyApplied: "LEGACY_HIGHEST_ASK",
      };
    }

    return {
      yesInRange,
      noInRange,
      selectedSide,
      selectedPrice,
      reason: "legacy_highest_ask_selected",
      policyApplied: "LEGACY_HIGHEST_ASK",
    };
  }

  if (yesInRange && !noInRange) {
    return {
      yesInRange,
      noInRange,
      selectedSide: "YES",
      selectedPrice: input.yesAsk,
      reason: "yes_only_in_range",
      policyApplied: null,
    };
  }

  if (noInRange && !yesInRange) {
    return {
      yesInRange,
      noInRange,
      selectedSide: "NO",
      selectedPrice: input.noAsk,
      reason: "no_only_in_range",
      policyApplied: null,
    };
  }

  if (!yesInRange && !noInRange) {
    return {
      yesInRange,
      noInRange,
      selectedSide: null,
      selectedPrice: null,
      reason: "neither_side_in_range",
      policyApplied: null,
    };
  }

  switch (input.bothSidesPolicy) {
    case "YES":
      return {
        yesInRange,
        noInRange,
        selectedSide: "YES",
        selectedPrice: input.yesAsk,
        reason: "both_in_range_policy_yes",
        policyApplied: "YES",
      };
    case "NO":
      return {
        yesInRange,
        noInRange,
        selectedSide: "NO",
        selectedPrice: input.noAsk,
        reason: "both_in_range_policy_no",
        policyApplied: "NO",
      };
    case "LOWER_PRICE": {
      if (input.yesAsk === input.noAsk) {
        return {
          yesInRange,
          noInRange,
          selectedSide: null,
          selectedPrice: null,
          reason: "both_in_range_tie_lower_price_policy",
          policyApplied: "LOWER_PRICE",
        };
      }
      const selectedSide: Side = input.yesAsk < input.noAsk ? "YES" : "NO";
      return {
        yesInRange,
        noInRange,
        selectedSide,
        selectedPrice: selectedSide === "YES" ? input.yesAsk : input.noAsk,
        reason: "both_in_range_policy_lower_price",
        policyApplied: "LOWER_PRICE",
      };
    }
    case "HIGHER_PRICE": {
      if (input.yesAsk === input.noAsk) {
        return {
          yesInRange,
          noInRange,
          selectedSide: null,
          selectedPrice: null,
          reason: "both_in_range_tie_higher_price_policy",
          policyApplied: "HIGHER_PRICE",
        };
      }
      const selectedSide: Side = input.yesAsk > input.noAsk ? "YES" : "NO";
      return {
        yesInRange,
        noInRange,
        selectedSide,
        selectedPrice: selectedSide === "YES" ? input.yesAsk : input.noAsk,
        reason: "both_in_range_policy_higher_price",
        policyApplied: "HIGHER_PRICE",
      };
    }
    case "SKIP":
    default:
      return {
        yesInRange,
        noInRange,
        selectedSide: null,
        selectedPrice: null,
        reason: "both_in_range_policy_skip",
        policyApplied: "SKIP",
      };
  }
}

export function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
