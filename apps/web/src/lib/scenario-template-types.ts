export type ScenarioTemplateId = "dentist" | "barber" | "tutor" | "auto" | "beauty" | "echte-doner" | "carwash";

export type ScenarioTemplate = {
  id: ScenarioTemplateId;
  title: string;
  description: string;
  inboundPrompt: string;
  outboundPrompt: string;
  inboundGreeting: string;
  outboundGreeting: string;
};
