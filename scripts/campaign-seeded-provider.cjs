// Only loaded by the explicitly isolated browser runner, never the application.
const provenance = {
  providerId: "isolated-seeded-fixture",
  params: {},
  recipe: "revision-campaign",
  recipeVersion: "1.1.0",
};
exports.install = (SceneProseService) => {
  SceneProseService.prototype.reviewCampaign = async (task, context) => {
    let output;
    if (task === "scan") {
      const citation = context.source;
      const rule = {
        text: "Preserve the brass key, the red seal and the restrained close viewpoint.",
        citations: [citation],
      };
      output = {
        summary: "Make the antagonist’s pressure deliberate.",
        rechecks: (context.reviewTargets ?? []).map((x) => ({
          target: x.target,
          assessment: "holds",
          explanation:
            "Current saved prose preserves the linked clue and chapter boundary.",
          citations: [x.boundary?.ending ?? x.boundary?.opening ?? citation],
        })),
        suggestions: { facts: [rule], voice: [rule] },
        steps: context.previouslyResolved
          ? []
          : [
              {
                id: "local",
                sceneId: citation.sceneId,
                chapterId: context.chapterId,
                title: "Make the pressure deliberate",
                instruction:
                  "Add a restrained indication that Mara watches the exits, preserving all facts and voice.",
                citations: [citation],
                prerequisites: [],
                consequences: [
                  {
                    prediction:
                      "Recheck the later confession and neighboring boundary.",
                    citations: [citation],
                  },
                ],
                questions: [],
                manual: false,
              },
            ],
        gaps: [],
      };
    } else if (task === "synthesize") {
      const steps = context.groups.flatMap((x) => x.steps);
      output = {
        summary:
          "Coordinate the setup, escalation and payoff across the manuscript.",
        steps: steps.map((step, index) => ({
          ...step,
          prerequisites: index ? [steps[index - 1].id] : [],
          consequences: [
            {
              prediction:
                "Recheck the later confession and neighboring chapter boundary.",
              citations: steps.slice(0, 5).map((x) => x.citations[0]),
            },
          ],
        })),
        gaps: [],
      };
    } else {
      output = {
        passed: true,
        facts: "The brass key and red seal remain unchanged.",
        voice:
          "Close viewpoint, restrained diction and sentence cadence remain.",
        consequences:
          "The additional pressure prepares the confession. Review the linked evidence after approval.",
        citations: context.campaign.step.citations,
        failures: [],
      };
    }
    const { entries } =
      require("../ProserFactory/dist/documents/campaignCitations").campaignCitationCatalog(
        context,
      );
    const reference = (value) => {
      if (Array.isArray(value)) return value.map(reference);
      if (value && typeof value === "object") {
        if (typeof value.quote === "string" && value.sceneRevisionId) {
          const match = [...entries].find(
            ([, proof]) =>
              proof.sceneId === value.sceneId &&
              proof.sceneRevisionId === value.sceneRevisionId &&
              proof.blockId === value.blockId &&
              proof.from === value.from &&
              proof.to === value.to &&
              proof.quote === value.quote,
          );
          if (!match)
            throw Error("Synthetic provider used undisclosed evidence");
          return { citationId: match[0] };
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, reference(child)]),
        );
      }
      return value;
    };
    return { raw: JSON.stringify(reference(output)), provenance };
  };
  SceneProseService.prototype.proposeDocumentEdits = async (snapshot) => ({
    raw: JSON.stringify({
      reply: "Make the waiting deliberate.",
      edits: [
        {
          targetId: snapshot.targets[0].targetId,
          sourceText: snapshot.targets[0].sourceText,
          replacement: snapshot.targets[0].sourceText.replace(
            "waited by",
            "waited, counting exits, by",
          ),
        },
      ],
    }),
    provenance,
  });
};
