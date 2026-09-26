import { Replay } from "../replay/Replay";
import { Nav } from "./Nav";
import { Hero } from "./Hero";
import { CollapseScenarios } from "./CollapseScenarios";
import { TakerComparison } from "./TakerComparison";
import { YieldCalculator } from "./YieldCalculator";
import { Architecture } from "./Architecture";
import { SecurityModules } from "./SecurityModules";
import { Footer } from "./Footer";

/** The full results narrative: LP opportunity first, then real fork-replay proof, then the mechanism. */
export function Landing() {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Nav />
      <Hero />
      <YieldCalculator />
      <div className="landing-section" id="attack-replay" style={{ paddingTop: 8 }}>
        <Replay />
      </div>
      <TakerComparison />
      <CollapseScenarios />
      <Architecture />
      <SecurityModules />
      <Footer />
    </div>
  );
}
