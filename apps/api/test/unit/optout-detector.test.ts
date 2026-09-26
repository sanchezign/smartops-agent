import { describe, expect, it } from "vitest";
import { detectComplianceEvent } from "../../src/modules/optout/optout-detector.js";

const keywords = { optOut: ["BAJA", "STOP", "CANCELAR", "UNSUBSCRIBE"], optIn: ["ALTA", "START"] };
const detect = (text: string) => detectComplianceEvent(text, keywords);

describe("detectComplianceEvent — deterministic, no LLM (ADR-017)", () => {
  it.each([
    "BAJA",
    "baja",
    "Stop!!!",
    "  CANCELAR  ",
    "unsubscribe",
    "Baja, gracias",
    "Por favor BAJA",
  ])("opts out on the bare keyword %j", (text) => {
    expect(detect(text)?.kind).toBe("opt_out");
  });

  it.each(["ALTA", "start", "Alta por favor", "START, gracias"])("opts in on %j", (text) => {
    expect(detect(text)?.kind).toBe("opt_in");
  });

  it.each([
    "baja el cemento 10%",
    "el cemento bajó de precio",
    "bajá 10% en tornillos",
    "Lista septiembre: tornillo 6mm 12 UYU, tuerca 6mm 5 UYU",
    "hola",
    "gracias",
    "STOP the presses, tengo una duda", // keyword but not the whole message
    "start selling faster please",
  ])("never matches a normal message: %j", (text) => {
    expect(detect(text)).toBeNull();
  });

  it.each([
    "no me escriban mas por favor",
    "No me manden más mensajes",
    "no quiero recibir mas mensajes de ustedes",
    "Dejen de escribirme",
    "quiero darme de baja de la lista",
    "deseo darme de baja",
    "saquenme de la lista",
    "Borrenme de la lista, gracias",
  ])("opts out on an explicit short phrase: %j", (text) => {
    expect(detect(text)?.kind).toBe("opt_out");
  });

  it.each([
    "ya no trabajo con ustedes",
    "ya no necesito mas",
    "no me interesa mas",
    "dejen de mandarme cosas",
  ])("flags an ambiguous phrase as possible_opt_out (never auto-applied): %j", (text) => {
    expect(detect(text)?.kind).toBe("possible_opt_out");
  });

  it("a phrase inside a long message (e.g. a price list) is ignored", () => {
    const long = Array.from({ length: 20 }, (_, i) => `producto${i} ${i}0 UYU`).join(", ");
    expect(detect(`no me escriban mas: ${long}`)).toBeNull();
  });

  it("is accent and case insensitive (per the required config: case/accents-insensitive)", () => {
    expect(detect("BAJÁ")?.kind).toBe("opt_out");
    expect(detect("Cancelár")?.kind).toBe("opt_out");
    expect(detect("CANCELAR")?.kind).toBe("opt_out");
  });

  it("empty or whitespace-only text never matches", () => {
    expect(detect("")).toBeNull();
    expect(detect("   ")).toBeNull();
    expect(detect("!!!")).toBeNull();
  });

  it("uses the keywords passed in, not a hardcoded list", () => {
    expect(detectComplianceEvent("SALIR", { optOut: ["SALIR"], optIn: ["ENTRAR"] })).toMatchObject({
      kind: "opt_out",
      matched: "salir",
    });
  });
});
