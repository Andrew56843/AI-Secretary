import { CARWASH_SCENARIO_TEMPLATE } from "./carwash-scenario-template";
import { RESTAURANT_SCENARIO_TEMPLATE } from "./restaurant-scenario-template";
import { SERVICE_SCENARIO_TEMPLATES } from "./service-scenario-templates";
import type { ScenarioTemplate } from "./scenario-template-types";

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  ...SERVICE_SCENARIO_TEMPLATES,
  RESTAURANT_SCENARIO_TEMPLATE,
  CARWASH_SCENARIO_TEMPLATE
];
