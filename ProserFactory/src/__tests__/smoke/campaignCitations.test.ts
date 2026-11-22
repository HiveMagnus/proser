import { randomUUID } from "node:crypto";
import {
  campaignCitationCatalog,
  resolveCampaignCitations,
  campaignPrompt,
  campaignScanRules,
} from "@/documents/campaignCitations";
import type { CampaignCitation } from "@/documents/campaign-model";
const citation = (
  quote = "Saved prose 😀 e\u0301",
  from = 17,
): CampaignCitation => ({
  sceneId: 1,
  sceneRevisionId: randomUUID(),
  blockId: "paragraph-one",
  from,
  to: from + quote.length,
  quote,
});
describe("server-issued campaign citation references", () => {
  test("resolves exact saved identity and offsets without model position arithmetic", () => {
    const source = citation(),
      context = { source, boundary: source };
    const catalog = campaignCitationCatalog(context);
    expect(catalog.entries.size).toBe(1);
    const citationId = [...catalog.entries.keys()][0];
    expect(
      resolveCampaignCitations(
        JSON.stringify({ citations: [{ citationId }] }),
        context,
      ),
    ).toEqual({ citations: [source] });
    expect(campaignPrompt("scan", context)).toContain(citationId);
  });
  test("historical protection baselines cannot be selected as current scan evidence", () => {
    const historical = citation("Original voice before the revision."),
      current = { ...historical, sceneRevisionId: randomUUID(), quote: "Current revised voice." };
    current.to = current.from + current.quote.length;
    const context = {
      source: current,
      constraints: campaignScanRules({
        facts: [{ text: "Keep the brass key.", citations: [historical] }],
        voice: [{ text: "Restrained voice.", citations: [historical] }],
      }),
    };
    const catalog = campaignCitationCatalog(context);
    expect([...catalog.entries.values()]).toEqual([current]);
    expect(campaignPrompt("scan", context)).toContain(historical.quote);
    const oldId = [...campaignCitationCatalog({ source: historical }).entries.keys()][0];
    expect(() => resolveCampaignCitations(JSON.stringify({ citations: [{ citationId: oldId }] }), context)).toThrow("undisclosed");
  });
  test("rejects invented references and references from another immutable source", () => {
    const source = citation(),
      citationId = [...campaignCitationCatalog({ source }).entries.keys()][0];
    expect(() =>
      resolveCampaignCitations(
        JSON.stringify({ citations: [{ citationId: "forged" }] }),
        { source },
      ),
    ).toThrow("undisclosed");
    expect(() =>
      resolveCampaignCitations(
        JSON.stringify({ citations: [{ citationId }] }),
        { source: { ...source, sceneRevisionId: randomUUID() } },
      ),
    ).toThrow("undisclosed");
  });
  test("catalog ranges cover long text exactly once at Unicode-safe source offsets", () => {
    const source = citation("😀 e\u0301 saved text. ".repeat(600), 71);
    const catalog = campaignCitationCatalog({ source });
    const ranges = [...catalog.entries.values()];
    expect(ranges.map((range) => range.quote).join("")).toBe(source.quote);
    expect(ranges[0].from).toBe(source.from);
    ranges
      .slice(1)
      .forEach((range, index) => expect(range.from).toBe(ranges[index].to));
    expect(ranges.at(-1)!.to).toBe(source.to);
    expect(
      ranges.every(
        (range) =>
          range.quote.length <= 4000 && !range.quote.startsWith("\u0301"),
      ),
    ).toBe(true);
  });
});
