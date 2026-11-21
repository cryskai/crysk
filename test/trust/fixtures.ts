// The marker trust the existing suites post and read under. Their fixtures stand in for a review
// posted by a person's account ("pr-hero", "pr-hero-bot"), so they name those logins once here
// instead of each fixture changing its author. Trust tests build their own.

import { markerTrust } from "../../src/trust/marker-trust";

export const FIXTURE_MARKER_TRUST = markerTrust(["pr-hero", "pr-hero-bot"]);
