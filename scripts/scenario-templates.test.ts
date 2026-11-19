import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { SCENARIO_TEMPLATES } from "../apps/web/src/lib/scenario-templates";

test("catalog keeps five existing examples and adds two for an eight-choice picker", () => {
  assert.deepEqual(SCENARIO_TEMPLATES.map(template => template.id), ["dentist", "barber", "tutor", "auto", "beauty", "echte-doner", "carwash"]);
  assert.equal(new Set(SCENARIO_TEMPLATES.map(template => template.id)).size, 7);
  for (const template of SCENARIO_TEMPLATES) {
    assert.ok(template.title.trim() && template.description.trim());
    for (const prompt of [template.inboundPrompt, template.outboundPrompt]) {
      assert.ok(prompt.trim().length >= 20 && prompt.length <= 6000, `${template.id}: prompt length ${prompt.length}`);
      assert.doesNotMatch(prompt, /Перевожу вас на создателя|Говори в мужском роде|\{\{[^}]+\}\}/u);
    }
    for (const greeting of [template.inboundGreeting, template.outboundGreeting]) {
      assert.ok(greeting.trim().length >= 4 && greeting.length <= 600);
      assert.match(greeting, /ИИ-секретарь/u);
    }
    assert.notEqual(template.inboundPrompt, template.outboundPrompt);
  }
});

test("service examples include concrete prices, durations, addresses and appointment rules", () => {
  for (const template of SCENARIO_TEMPLATES.filter(template => template.id !== "echte-doner")) {
    for (const prompt of [template.inboundPrompt, template.outboundPrompt]) {
      assert.match(prompt, /Ставрополь/u, template.id);
      assert.match(prompt, /\d+\s*(?:₽|руб\.)/u, template.id);
      assert.match(prompt, /\d+\s*мин/iu, template.id);
      assert.match(prompt, /\d{2}:\d{2}/u, template.id);
      assert.match(prompt, /обед|перерыв/iu, template.id);
      assert.match(prompt, /календар/iu, template.id);
    }
  }
});

test("Echte Doner retains menu prices, portion units and delivery terms", () => {
  const template = SCENARIO_TEMPLATES.find(template => template.id === "echte-doner")!;
  for (const prompt of [template.inboundPrompt, template.outboundPrompt]) {
    for (const value of ["Пушкина, 25", "Кулакова, 29Д", "650 ₽", "150 ₽", "900 ₽", "Дюрюм Дёнер — 319 ₽/400 г", "Дёнер — 305 ₽/430 г", "Шримп Ролл — 335 ₽/215 г", "Картофель Фри — 115 ₽/100 г", "Наггетсы — 99 ₽/3 шт", "Добрый Кола — 110 ₽", "сок 0,2 л", "каждый 0,5 л"]) {
      assert.ok(prompt.includes(value), value);
    }
    assert.match(prompt, /подтверд/u);
    assert.match(prompt, /инструмент/u);
    assert.match(prompt, /не проверенный актуальный прайс/u);
  }
});

const pageSource = ts.createSourceFile("DashboardPage.tsx", readFileSync(new URL("../apps/web/src/pages/DashboardPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handlerSource() {
  let found: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "handleTemplateSelect") found = node;
    ts.forEachChild(node, visit);
  }
  visit(pageSource);
  if (!found) throw new Error("Template picker handler was not found");
  return found.getText(pageSource);
}

test("actual picker handler only fills the selected draft and leaves saved profiles untouched", () => {
  for (const activeMode of ["inbound", "outbound"] as const) {
    for (const template of SCENARIO_TEMPLATES) {
      const original = Object.freeze({ title: "Мой сценарий", businessName: "Моё дело", prompt: "Сохранённый текст", greetingText: "Здравствуйте!", promptRequest: "Изменить", voice: "marin", realtimeModel: "gpt-realtime-2", forwardingEnabled: false, forwardingOnComplete: true, forwardingOnStalemate: false, maxDialogSeconds: 180 });
      let form = { ...original };
      let open = { inbound: true, outbound: true };
      let dismissed = { inbound: false, outbound: false };
      let history: Record<string, string[]> = { inbound: ["Входящие"], outbound: ["Исходящие"] };
      const bindings = {
        activeMode, SCENARIO_TEMPLATES,
        setForm: (update: (value: typeof form) => typeof form) => { form = update(form); },
        setTemplatePickerOpen: (update: (value: typeof open) => typeof open) => { open = update(open); },
        setTemplatePickerDismissed: (update: (value: typeof dismissed) => typeof dismissed) => { dismissed = update(dismissed); },
        setPromptEditHistoryByMode: (update: (value: typeof history) => typeof history) => { history = update(history); }
      };
      const javascript = ts.transpileModule(`return (${handlerSource()})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
      const select = new Function(...Object.keys(bindings), javascript)(...Object.values(bindings));
      select(template.id);
      assert.deepEqual(form, { ...original, prompt: template[activeMode === "inbound" ? "inboundPrompt" : "outboundPrompt"], greetingText: template[activeMode === "inbound" ? "inboundGreeting" : "outboundGreeting"], promptRequest: "" });
      assert.equal(original.prompt, "Сохранённый текст");
      assert.equal(open[activeMode], false);
      assert.equal(dismissed[activeMode], true);
      assert.deepEqual(history[activeMode], []);
      assert.deepEqual(history[activeMode === "inbound" ? "outbound" : "inbound"], [activeMode === "inbound" ? "Исходящие" : "Входящие"]);
      select("custom");
      assert.equal(form.prompt, template[activeMode === "inbound" ? "inboundPrompt" : "outboundPrompt"]);
    }
  }
});
