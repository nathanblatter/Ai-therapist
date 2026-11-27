// Shared by the redaction eval runners: try a CANDIDATE redaction wording
// without changing the product. `--wording <file.json>` names a list of
// {"find": "...", "replace": "..."} edits; each is applied to the
// `instructions` of every redaction request the production code sends during
// the run (the leak check and every other call are untouched). An edit whose
// `find` text is not in the instructions stops the run, so a candidate can
// never silently measure the unedited wording.
//
// Nothing here ships: the wording in src/server/services/redaction.service.ts
// is what production sends, and changing it needs the PI's sign-off and a
// regenerated IRB prompts attachment.
import { readFileSync } from 'node:fs';

/** Returns a label for the run ("production wording" or the file name). */
export function applyCandidateWording(responsesResource, file, redactionModel = 'gpt-5') {
  if (!file) return 'production wording';
  const edits = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(edits) || edits.some((e) => typeof e.find !== 'string' || typeof e.replace !== 'string')) {
    throw new Error(`${file}: expected a JSON array of {"find", "replace"} objects`);
  }
  const proto = Object.getPrototypeOf(responsesResource);
  const realCreate = proto.create;
  proto.create = function candidateWordingCreate(body, ...rest) {
    if (body?.model !== redactionModel || typeof body.instructions !== 'string') {
      return realCreate.call(this, body, ...rest);
    }
    let instructions = body.instructions;
    for (const { find, replace } of edits) {
      if (!instructions.includes(find)) {
        return Promise.reject(
          Object.assign(new Error(`candidate wording: text to replace not found: "${find.slice(0, 60)}"`), {
            status: 401,
          }),
        );
      }
      instructions = instructions.replace(find, replace);
    }
    return realCreate.call(this, { ...body, instructions }, ...rest);
  };
  return `candidate wording ${file}`;
}
