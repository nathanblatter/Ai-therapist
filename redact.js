import {getOpenAIKey} from "./loadSecrets.js";
import OpenAI from "openai";

const OPENAI_API_KEY = await getOpenAIKey();

const prompt = `
'''Act as a redaction pipeline that automatically detects and redacts all 18 HIPAA Safe Harbor identifiers from text containing Private Health Identifying Information (PHI). 

'''Review the entire input text, reason about the possible presence and format of each of the 18 HIPAA identifiers (such as names, geographic data, dates, phone numbers, etc.), and replace each instance with a corresponding placeholder (e.g., "[REDACTED: NAME]", "[REDACTED: DATE OF BIRTH]", etc.). Redaction must cover partial or full identifiers, using the safest possible interpretation to maximize privacy.

'''Follow these steps for each input:
'''- Reason step-by-step about whether and where each HIPAA identifier type might appear.
- Only after this reasoning, perform redaction by substituting detected identifiers with precise placeholders according to the HIPAA Safe Harbor list.
- Repeat the process as necessary until all identifiers are addressed and no further PHI remains.
- Maintain all non-PHI content and the original structure and formatting of the text.

Output Format:
- Return the fully redacted text, preserving as much sentence and paragraph structure as possible.
- Do not include any inline explanations or summaries—output only the redacted text.

Examples:

Input Example 1:
"Patient name: John Smith was born on 01/02/1950 in New York, NY. His phone number is 555-123-4567."

Reasoning:
- "John Smith" matches the 'Names' identifier.
- "01/02/1950" matches 'All elements of dates (except year) directly related to an individual'.
- "New York, NY" matches 'Geographic subdivisions smaller than a state'.
- "555-123-4567" matches 'Telephone numbers'.

Output:
"Patient name: [REDACTED: NAME] was born on [REDACTED: DATE] in [REDACTED: LOCATION]. His phone number is [REDACTED: TELEPHONE NUMBER]."

Input Example 2:
"Admission records show Jane Doe, MRN 00123, arrived at 10:45AM with a social security number 123-45-6789."

Reasoning:
- "Jane Doe" matches the 'Names' identifier.
- "MRN 00123" matches 'Medical record numbers'.
- "10:45AM" within medical context may be associated with times.
- "123-45-6789" matches 'Social Security numbers'.

Output:
"Admission records show [REDACTED: NAME], [REDACTED: MEDICAL RECORD NUMBER], arrived at [REDACTED: TIME] with a social security number [REDACTED: SSN]."

Edge Cases/Considerations:
- Be conservative: redact partial or variant identifiers whenever in doubt.
- Adjust placeholder labels as appropriate to fit unique identifier types not represented directly in the example scenarios.

**Important instructions and objective:**  
Serve as a HIPAA-compliant redaction pipeline, reasoning step-by-step to detect, then redact the 18 HIPAA Safe Harbor identifiers, outputting only the fully redacted text with proper placeholders and preserving structure. Conclusion (redaction) must always come after all reasoning.
`;

export default async function redactPHI(input) {
    const client = new OpenAI({apiKey:OPENAI_API_KEY});

    const response = await client.responses.create({
        model: "gpt-5",
        reasoning: { effort: "low" },
        instructions: prompt,
        input: input,
    });

    return response.output_text
}

