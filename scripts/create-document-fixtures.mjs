import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const require = createRequire(
  new URL("../ProserFactory/package.json", import.meta.url),
);
const {
  documentFromText,
  replaceDocumentText,
  regenerateDocumentText,
  projectDocument,
  canonicalDocument,
} = require("./dist/documents/model");
const { exportStructuredDocx } = require("./dist/documents/docxExport");
if (!process.argv[2])
  throw new Error("Supply a disposable fixture output directory.");
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
let sequence = 0;
const id = () => `fixture-${++sequence}`;
const author = {
  authorId: 1,
  authorName: "Fixture author",
  createdAt: "2026-10-05T12:00:00.000Z",
  origin: "ai",
  status: "pending",
};
const initial = documentFromText(
  "A careful voyage begins.\n\nThe storm grows.\n\nFirst numbered item\n\nSecond numbered item",
  id,
);
const source = projectDocument(initial).text;
const start = source.indexOf("storm");
const document = replaceDocumentText(
  initial,
  start,
  start + 5,
  "storm",
  "tide",
  id,
  author,
);
const first = document.blocks[0];
first.style = {
  heading: 1,
  alignment: "left",
  keepWithNext: true,
  before: 4,
  after: 8,
};
first.runs[0].style = {
  bold: true,
  italic: false,
  font: "Liberation Serif",
  size: 20,
  color: "#123456",
};
document.changes.push({
  ...author,
  id: id(),
  kind: "format",
  targetRunIds: [first.runs[0].id],
  beforeStyle: { bold: false, font: "Liberation Serif", size: 16 },
  afterStyle: first.runs[0].style,
});
document.blocks[2].style = { list: "number" };
document.blocks[3].style = { list: "number" };
const paragraph = (text, style = {}) => ({
  type: "paragraph",
  id: id(),
  style: {},
  runs: [{ id: id(), text, style }],
});
const cellParagraph = paragraph("Table cell 😀 e\u0301", { italic: true });
document.blocks.push({
  type: "table",
  id: id(),
  widths: [200, 200],
  rows: [
    {
      id: id(),
      cells: [
        { id: id(), paragraphs: [cellParagraph] },
        { id: id(), paragraphs: [paragraph("Protected object")] },
      ],
    },
  ],
});
for (const [block, text] of [
  [first, "careful"],
  [cellParagraph, "Table cell"],
]) {
  const run = block.runs[0];
  const offset = run.text.indexOf(text);
  document.comments.push({
    id: id(),
    authorId: 1,
    authorName: "Fixture author",
    createdAt: author.createdAt,
    text: "Classic anchored fixture comment.",
    resolved: false,
    anchors: [
      {
        blockId: block.id,
        runId: run.id,
        start: offset,
        end: offset + text.length,
        sourceText: text,
      },
    ],
  });
}
document.layout.font = "Liberation Serif";
document.layout.header = [
  paragraph("Fixture header", {
    hyperlink: "https://example.com/fixture-header",
  }),
];
document.layout.footer = [paragraph("Fixture footer")];
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgcY4EAAEHAKmKqmQVAAAAAElFTkSuQmCC",
  "base64",
);
for (let index = 0; index < 2; index++)
  document.blocks.push({
    type: "image",
    id: id(),
    assetId: 1,
    sha256: createHash("sha256").update(image).digest("hex"),
    alt: "One-pixel fixture image",
    width: 24,
    height: 24,
  });
const assets = new Map([[1, { bytes: image, mediaType: "image/png" }]]);
const artifacts = [];
for (const mode of ["final", "original", "retain-review"]) {
  const bytes = await exportStructuredDocx(document, mode, assets);
  const file = `${mode}.docx`;
  await writeFile(resolve(output, file), bytes);
  artifacts.push({
    file,
    mode,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const paragraphDirectory = resolve(output, "paragraphs");
await mkdir(paragraphDirectory, { recursive: true });
const paragraphDocument = regenerateDocumentText(
  documentFromText("Before first.\n\nBefore second.", id),
  "After first.\n\nAfter second.",
  id,
  author,
);
await writeFile(
  resolve(paragraphDirectory, "source.json"),
  canonicalDocument(paragraphDocument),
);
for (const mode of ["final", "original", "retain-review"]) {
  const bytes = await exportStructuredDocx(paragraphDocument, mode, new Map());
  const file = `paragraphs/${mode}.docx`;
  await writeFile(resolve(output, file), bytes);
  artifacts.push({
    file,
    mode,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(resolve(output, "source.json"), canonicalDocument(document));
await writeFile(
  resolve(output, "manifest.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      fixtureOnly: true,
      sourceHash: createHash("sha256")
        .update(canonicalDocument(document))
        .digest("hex"),
      artifacts,
      validationScope:
        "OOXML schema and independent LibreOffice rendering. Import round trips, full publication and Microsoft Word remain unverified.",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ directory: output, artifacts }));
