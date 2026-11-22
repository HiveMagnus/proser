// An incompatible checkpoint requires an explicit inactive Factory response.
// Missing, malformed or unavailable authority never permits the old editor.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 65536) throw new Error('Invalid bounded readiness response.');
}
const response = JSON.parse(input);
const components = response.success === true && response.data?.components;
if (
  !components ||
  components.documentSchema !== 'disabled' ||
  components.documentEnforcement !== 'disabled'
)
  throw new Error(
    'Rollback checkpoint lacks structured-document support; Factory authority is active or unknown. Use a document-compatible release.',
  );
