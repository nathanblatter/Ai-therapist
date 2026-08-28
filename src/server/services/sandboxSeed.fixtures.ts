// Deterministic template pools for sandbox caseload seeding (caseworker
// portal, docs/caseworker-portal.md section 7). Ports the demoFixtures.ts
// archetypes (improving-anxiety, crisis-and-recovery, long-continuity-burnout,
// brand-new) into DB-writing persona pools consumed by sandboxSeed.ts.
//
// EVERYTHING here is invented. No LLM is ever called at sandbox signup: all
// summaries, SOAP drafts, transcripts, screener trajectories, and note
// snippets are canned text selected by the seeded PRNG. Keep this file free
// of imports from LLM-touching modules.

export type MoodArc = 'improving' | 'flat' | 'declining';

export interface ShowcaseTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface PersonaSoapPools {
  subjective: string[];
  objective: string[];
  assessment: string[];
  plan: string[];
}

export interface PersonaPractice {
  title: string;
  description: string;
  kind: 'worksheet' | 'exercise' | 'observation' | 'custom';
}

export interface SandboxPersona {
  /** username stem; the seeder suffixes the org id for global uniqueness */
  handle: string;
  archetype:
    | 'improving_anxiety'
    | 'crisis_recovery'
    | 'burnout_continuity'
    | 'brand_new'
    | 'flat_maintenance'
    | 'declining';
  /** inclusive range of weeks of history */
  weeks: [number, number];
  /** inclusive range of ended sessions to seed */
  sessions: [number, number];
  moodArc: MoodArc;
  /** pre-session check-in mood (1-10) at the start/end of the arc */
  mood: { start: number; end: number };
  /** PHQ-2 score trajectory (0-6) */
  phq2: { start: number; end: number };
  /** GAD-2 score trajectory (0-6) */
  gad2: { start: number; end: number };
  topics: string[];
  techniques: string[];
  headlines: string[];
  followUps: string[];
  soap: PersonaSoapPools;
  /** caseworker-voice case-note narratives */
  caseNotes: string[];
  practice: PersonaPractice[];
  /** two scripted showcase transcripts (12-16 turns each); every other
   *  seeded session deliberately has NO transcript (SessionDetail shows the
   *  synthetic empty-state card) */
  showcase: [ShowcaseTurn[], ShowcaseTurn[]];
  /** crisis-arc client: gets crisis events, risk spikes, and a safety plan */
  crisis?: boolean;
  safetyPlan?: {
    warning_signs: string[];
    coping_strategies: string[];
    support_contacts: string[];
    reasons_worth_living: string[];
    professional_resources: string[];
  };
}

// ---------------------------------------------------------------------------
// Shared pools
// ---------------------------------------------------------------------------

export const RISK_FACTOR_POOLS = {
  quiet: {
    method: 'keyword+llm',
    keywords: [] as string[],
    llm_context: 'no_risk_language',
    llm_reasoning: 'Everyday stressors discussed; no ideation or risk language present.',
  },
  passive: {
    method: 'keyword+llm',
    keywords: ['better off'],
    llm_context: 'passive_ideation',
    llm_reasoning: 'Passive ideation markers surfaced; no plan or intent stated. Trajectory rising.',
    trajectory_trend: 'rising',
  },
  active: {
    method: 'keyword+llm',
    keywords: ['ending my life'],
    llm_context: 'active_ideation_no_plan',
    llm_reasoning:
      'Client confirms suicidal thoughts on direct inquiry; denies intent or plan. Protocol requires escalation and safety-plan activation.',
    trajectory_trend: 'rising',
  },
  deescalating: {
    method: 'keyword+llm',
    keywords: [] as string[],
    llm_context: 'de_escalating',
    llm_reasoning: 'Client engaged with the safety plan and grounding exercise; distress decreasing.',
    trajectory_trend: 'falling',
  },
};

export const SESSION_NAME_POOL = [
  'Weekly check-in',
  'Working through a hard week',
  'Practice review and next steps',
  'Sleep and stress follow-up',
  'Between-session practice debrief',
  'Managing a setback',
  'Values and small experiments',
  'Progress review',
];

export const CHECKIN_TOPIC_POOL = [
  'work stress',
  'sleep',
  'family',
  'motivation',
  'anxiety spikes',
  'relationship',
  'health worries',
];

export const CHECKIN_GOAL_POOL = [
  'get through the week calmer',
  'practice one coping skill',
  'talk through a specific situation',
  'plan the next few days',
  'review how the exercise went',
];

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

const IMPROVING_ANXIETY_SHOWCASE: [ShowcaseTurn[], ShowcaseTurn[]] = [
  [
    { role: 'assistant', text: 'Welcome back. Last time you wanted to work on the Sunday-night dread before the work week. How has that been?' },
    { role: 'user', text: 'Honestly a bit better. I tried the worry-window thing twice. It felt silly but it kind of worked.' },
    { role: 'assistant', text: 'That is a real win, silly-feeling or not. What did you notice when you contained the worrying to that window?' },
    { role: 'user', text: 'The thoughts still showed up at night but I could tell myself I already dealt with them.' },
    { role: 'assistant', text: 'You created some distance from the thoughts instead of being pulled into them. Was there a night it did not work?' },
    { role: 'user', text: 'Thursday. Big presentation Friday. I spiraled about messing it up.' },
    { role: 'assistant', text: 'Presentations have been a theme. Want to unpack what the spiral said would happen?' },
    { role: 'user', text: 'That I would freeze, everyone would think I am incompetent, and my manager would regret hiring me.' },
    { role: 'assistant', text: 'Three predictions stacked on each other. On Friday, what actually happened?' },
    { role: 'user', text: 'It went fine. I stumbled once and nobody cared. My manager said good job after.' },
    { role: 'assistant', text: 'So the catastrophe chain broke at step one. That gap between the prediction and the outcome is worth writing down — it is evidence your anxiety exaggerates.' },
    { role: 'user', text: 'Yeah. I should keep a list of times it turned out fine.' },
    { role: 'assistant', text: 'That is exactly a thought-record habit. Would you like a short worksheet for that this week?' },
    { role: 'user', text: 'Sure, that would help.' },
  ],
  [
    { role: 'assistant', text: 'Hi again. How did the evidence list go this week?' },
    { role: 'user', text: 'I wrote in it four times. Rereading it before the team meeting actually calmed me down.' },
    { role: 'assistant', text: 'You used your own past outcomes as an anchor — that is the skill working. What was the meeting like?' },
    { role: 'user', text: 'I even asked a question in front of everyone, which old me would never do.' },
    { role: 'assistant', text: 'That is a big step. What made it feel possible this time?' },
    { role: 'user', text: 'I figured the worst case was a few seconds of awkwardness, and I have survived those before.' },
    { role: 'assistant', text: 'You are doing the cost-benefit math your anxiety used to hide from you. Any places the anxiety still bites hard?' },
    { role: 'user', text: 'Sunday nights are still rough, just less rough.' },
    { role: 'assistant', text: 'Less rough is a trend line worth respecting. Want to plan one small Sunday-evening ritual to close the weekend gently?' },
    { role: 'user', text: 'Maybe a walk and prepping my Monday list before dinner instead of at midnight.' },
    { role: 'assistant', text: 'A walk plus an early Monday list. Concrete and kind to yourself. Shall we check how it went next time?' },
    { role: 'user', text: 'Yes. Thanks, this helped.' },
  ],
];

const CRISIS_SHOWCASE: [ShowcaseTurn[], ShowcaseTurn[]] = [
  [
    { role: 'assistant', text: 'I am glad you came back. Last week was heavy. How are you arriving today?' },
    { role: 'user', text: 'The anniversary is in three days. It keeps replaying. I barely slept.' },
    { role: 'assistant', text: 'Anniversaries can pull grief right back to the surface. What part replays the most?' },
    { role: 'user', text: 'That I was not there. Sometimes I think it should have been me. Everyone would be better off.' },
    { role: 'assistant', text: 'Thank you for trusting me with that. I want to ask directly, because it matters: are you having thoughts of ending your life?' },
    { role: 'user', text: 'Sometimes. Not a plan or anything. It just crosses my mind at night.' },
    { role: 'assistant', text: 'I hear you — thoughts crossing your mind, no plan or intent. That must be frightening to sit with alone. Do you have access to anything you would use to hurt yourself?' },
    { role: 'user', text: 'No, nothing like that. I do not actually want to die. I just want the hurt to stop.' },
    { role: 'assistant', text: 'Wanting the pain to stop makes complete sense, and there are ways to work toward that without you disappearing. I want to share the 988 Suicide and Crisis Lifeline — call or text 988, any hour. Would you be willing to build a small safety plan with me right now?' },
    { role: 'user', text: 'Okay. I can try.' },
    { role: 'assistant', text: 'Good. First: who is one person you could call when the nights get bad?' },
    { role: 'user', text: 'My sister. She has been checking on me.' },
    { role: 'assistant', text: 'Your sister goes at the top. And one thing that has helped even a little on a bad night?' },
    { role: 'user', text: 'Going outside. Cold air helps. And the breathing thing we did once.' },
    { role: 'assistant', text: 'Cold air and paced breathing — both on the plan. I am also flagging this conversation for your care team so they can check in with you. You are not carrying this alone.' },
    { role: 'user', text: 'Okay. That is probably good. Thank you.' },
  ],
  [
    { role: 'assistant', text: 'Welcome back. The anniversary was this week. I have been holding what you shared last time. How did it go?' },
    { role: 'user', text: 'Hard, but I got through it. My sister came over. We looked at photos and cried a lot.' },
    { role: 'assistant', text: 'You reached for your safety plan person and let the grief move instead of freezing it. How are the nights now?' },
    { role: 'user', text: 'Better. The dark thoughts have quieted down. Sleep is still rough.' },
    { role: 'assistant', text: 'I am glad the thoughts have quieted. To check in directly: any thoughts of ending your life this week?' },
    { role: 'user', text: 'No. Not since the anniversary passed. It feels different now, like a weight shifted.' },
    { role: 'assistant', text: 'That shift is worth marking. Grief will still come in waves, but you now have proof you can be in a wave without going under. What helped most?' },
    { role: 'user', text: 'Not being alone with it. And the breathing before bed, honestly.' },
    { role: 'assistant', text: 'Connection and a body-based skill — those are yours to keep. Would it help to plan how to handle the next hard date before it arrives?' },
    { role: 'user', text: 'Yes. His birthday is in two months. I want to be ready this time.' },
    { role: 'assistant', text: 'Then that is our project: a birthday plan, built early, with your sister in it. And your care team remains a call away.' },
    { role: 'user', text: 'Thank you. This is the first week I have felt something like hope.' },
  ],
];

const BURNOUT_SHOWCASE: [ShowcaseTurn[], ShowcaseTurn[]] = [
  [
    { role: 'assistant', text: 'Good to see you again. We have been tracking the exhaustion for a while now. Where is the tank today, zero to ten?' },
    { role: 'user', text: 'Maybe a three. I keep waking up tired no matter how early I sleep.' },
    { role: 'assistant', text: 'Waking up tired after enough hours often points at quality, not quantity. What do the last two hours before bed look like?' },
    { role: 'user', text: 'Email. I tell myself I am just clearing the inbox so tomorrow is lighter.' },
    { role: 'assistant', text: 'So work gets the last word every night. What happens in your body when a new email lands at 10pm?' },
    { role: 'user', text: 'Jaw tightens. I start composing replies in my head even after I close the laptop.' },
    { role: 'assistant', text: 'Your nervous system never gets the off-duty signal. Would you be open to an experiment: a hard email cutoff at 8pm, three nights this week?' },
    { role: 'user', text: 'Three nights feels doable. My manager might notice though.' },
    { role: 'assistant', text: 'What is the realistic cost of a reply arriving at 9am instead of 10pm?' },
    { role: 'user', text: 'Probably nothing. Nobody has ever complained about morning replies.' },
    { role: 'assistant', text: 'Then the experiment has low risk and a real potential payoff. What would you like to do with those reclaimed evenings?' },
    { role: 'user', text: 'Read fiction again. I have not finished a book in a year.' },
    { role: 'assistant', text: 'A book instead of an inbox. Let us see what three nights of that does to the morning tank.' },
    { role: 'user', text: 'Deal. I will report back.' },
  ],
  [
    { role: 'assistant', text: 'Welcome back. How did the 8pm email cutoff experiment land?' },
    { role: 'user', text: 'I managed two of the three nights. Slept noticeably better both times.' },
    { role: 'assistant', text: 'Two nights and a visible sleep difference — that is data. What happened the third night?' },
    { role: 'user', text: 'A "urgent" thread pulled me in. It was not actually urgent. It could have waited a week.' },
    { role: 'assistant', text: 'That gap between felt urgency and real urgency comes up a lot for you. What might help you check it in the moment?' },
    { role: 'user', text: 'Asking myself: will anyone be harmed if this waits until 9am? The answer is basically always no.' },
    { role: 'assistant', text: 'A one-question triage. Simple enough to use when you are depleted. How is the finished-a-book project?' },
    { role: 'user', text: 'Eighty pages in. First time in a year. It felt like being a person again.' },
    { role: 'assistant', text: 'Feeling like a person again is the whole point, not a side effect. Where do you want to push next — the cutoff to five nights, or protecting a weekend morning?' },
    { role: 'user', text: 'Weekend morning. Saturday until noon, no laptop.' },
    { role: 'assistant', text: 'Saturday-until-noon, laptop closed. Your energy is a budget, and you are finally the one spending it.' },
    { role: 'user', text: 'That is a good way to put it. See you next week.' },
  ],
];

const NEW_INTAKE_SHOWCASE: [ShowcaseTurn[], ShowcaseTurn[]] = [
  [
    { role: 'assistant', text: 'Hi, welcome. Your provider set this up so you have a place to practice between your sessions with them. Nothing here replaces those sessions. What brings you in today?' },
    { role: 'user', text: 'Honestly not sure where to start. Things have just felt heavy lately.' },
    { role: 'assistant', text: 'Heavy is a real place to start. When you say lately — weeks, months?' },
    { role: 'user', text: 'A couple of months. Since I moved. I do not really know anyone here yet.' },
    { role: 'assistant', text: 'A move plus a thinner support net — that combination weighs on most people. What does a typical evening look like right now?' },
    { role: 'user', text: 'Work, takeout, scrolling until too late. Repeat.' },
    { role: 'assistant', text: 'Thank you for being straight about it. If one small thing about that loop changed first, what would you pick?' },
    { role: 'user', text: 'The scrolling probably. It makes me feel worse but I keep doing it.' },
    { role: 'assistant', text: 'That is common — it numbs and drains at the same time. Would you be open to trying one tiny swap this week, like ten minutes of a walk before the phone comes out?' },
    { role: 'user', text: 'Ten minutes I can do.' },
    { role: 'assistant', text: 'Ten minutes it is. And we will just observe what happens, no grades. Anything else you want your care team to know as we start?' },
    { role: 'user', text: 'Just that I am actually trying. Even if it does not look like it some weeks.' },
    { role: 'assistant', text: 'That goes in as the headline. Trying counts, especially on the weeks it does not look like it.' },
  ],
  [
    { role: 'assistant', text: 'Welcome back — second session. How did the ten-minute walk experiment go?' },
    { role: 'user', text: 'Did it four days out of seven. Missed the rainy ones.' },
    { role: 'assistant', text: 'Four out of seven on a brand-new habit is genuinely good. Notice anything on the walk days?' },
    { role: 'user', text: 'The evenings felt less like a void. I even cooked twice instead of ordering.' },
    { role: 'assistant', text: 'One small change is already pulling other ones along. How is the loneliness piece sitting?' },
    { role: 'user', text: 'Still there. A coworker invited me to a climbing gym thing and I said maybe.' },
    { role: 'assistant', text: 'What is behind the maybe?' },
    { role: 'user', text: 'Fear of standing around awkward and new. Same as always.' },
    { role: 'assistant', text: 'New-place awkwardness is a toll gate, not a wall — it lasts about twenty minutes. What would make saying yes ten percent easier?' },
    { role: 'user', text: 'Knowing I can leave after an hour without it being weird.' },
    { role: 'assistant', text: 'Then take the exit ramp with you: go, and one hour is a complete success. Deal?' },
    { role: 'user', text: 'Deal. I will tell them yes.' },
  ],
];

const FLAT_SHOWCASE: [ShowcaseTurn[], ShowcaseTurn[]] = [
  [
    { role: 'assistant', text: 'Good to see you. Things have been steady for a few weeks — how does steady feel from the inside?' },
    { role: 'user', text: 'Fine, I guess. Not bad. Not great. Just flat.' },
    { role: 'assistant', text: 'Flat can be rest or it can be stuck. Which does this feel closer to?' },
    { role: 'user', text: 'Stuck, if I am honest. Days blur together.' },
    { role: 'assistant', text: 'What used to reliably make a day feel distinct for you?' },
    { role: 'user', text: 'Music. I played guitar most evenings. Have not touched it in months.' },
    { role: 'assistant', text: 'When you imagine picking it up tonight, what shows up?' },
    { role: 'user', text: 'A voice saying what is the point, I will be rusty.' },
    { role: 'assistant', text: 'Rusty is the price of re-entry, not a verdict. What would a no-stakes version look like — playing badly on purpose for five minutes?' },
    { role: 'user', text: 'Ha, playing badly on purpose. That actually takes the pressure off.' },
    { role: 'assistant', text: 'That is the assignment then: five bad minutes, three evenings. We are chasing texture in the week, not performance.' },
    { role: 'user', text: 'Okay. Five bad minutes. I can manage that.' },
  ],
  [
    { role: 'assistant', text: 'Welcome back. How were the five bad minutes of guitar?' },
    { role: 'user', text: 'They turned into thirty good ones twice. My fingers remembered more than I expected.' },
    { role: 'assistant', text: 'The rust story did not survive contact with reality. How did the rest of the week feel?' },
    { role: 'user', text: 'A little less blurry. I looked forward to the evenings, which is new.' },
    { role: 'assistant', text: 'Anticipation is a strong sign the flatness is lifting at the edges. Anything still dragging?' },
    { role: 'user', text: 'Mornings. Getting up is still a negotiation.' },
    { role: 'assistant', text: 'Would a small morning anchor help — something that exists only to be pleasant, like real coffee or a sunny spot?' },
    { role: 'user', text: 'There is a bakery two blocks away I keep meaning to try.' },
    { role: 'assistant', text: 'A bakery two blocks away sounds like a reason to be vertical. Twice this week?' },
    { role: 'user', text: 'Twice. And I will keep the guitar going.' },
    { role: 'assistant', text: 'Guitar in the evening, bakery in the morning. We are rebuilding texture on both ends of the day.' },
    { role: 'user', text: 'I like that framing. See you next week.' },
  ],
];

const DECLINING_SHOWCASE: [ShowcaseTurn[], ShowcaseTurn[]] = [
  [
    { role: 'assistant', text: 'Welcome back. Your check-in mood has been sliding the last few weeks. What is the biggest weight right now?' },
    { role: 'user', text: 'Work. The reorg means I am doing two jobs and interviewing for my own position.' },
    { role: 'assistant', text: 'That is a lot of threat and a lot of load at once. How is it showing up in your body and sleep?' },
    { role: 'user', text: 'Waking at 4am most nights. Snapping at my partner over nothing.' },
    { role: 'assistant', text: 'The 4am wake-ups and the short fuse are classic overload signals. What is one demand this week you could realistically put down or shrink?' },
    { role: 'user', text: 'Maybe the volunteer newsletter. I have been forcing myself to keep it going.' },
    { role: 'assistant', text: 'What would happen if you told them you need a two-month pause?' },
    { role: 'user', text: 'They would be fine. I am the only one who thinks it is mandatory.' },
    { role: 'assistant', text: 'Then that is recoverable ground. And for 4am: would you try getting up and doing something boring in low light instead of lying there rehearsing the reorg?' },
    { role: 'user', text: 'Better than what I am doing now. I lie there catastrophizing for two hours.' },
    { role: 'assistant', text: 'One thing off the plate, one plan for 4am. Small levers, but they compound. Let us check both next week.' },
    { role: 'user', text: 'Okay. I will send the newsletter email tomorrow.' },
  ],
  [
    { role: 'assistant', text: 'Hi. Last week you paused the newsletter and tried the 4am plan. How did it go?' },
    { role: 'user', text: 'Newsletter is paused and nobody blinked. The 4am thing I only managed once. Mostly still lying there.' },
    { role: 'assistant', text: 'One less obligation is real progress, and one attempt at 4am is a start, not a failure. What kept you in bed the other nights?' },
    { role: 'user', text: 'Too tired to get up but too wired to sleep. Stuck in between.' },
    { role: 'assistant', text: 'That in-between state is where the worry loop feeds. Want to try a version with less activation energy — sitting up in bed with a paper notepad and dumping every worry onto it?' },
    { role: 'user', text: 'A worry dump. I can keep a notepad on the nightstand.' },
    { role: 'assistant', text: 'Exactly. The page holds the rehearsal so your head does not have to. How are things with your partner this week?' },
    { role: 'user', text: 'A bit better. I told them about the interview stress instead of snapping. They took it well.' },
    { role: 'assistant', text: 'Naming the load instead of leaking it — that protects the relationship while you are stretched thin. And the interview itself is when?' },
    { role: 'user', text: 'Twelve days. I would like to prep for it here next time.' },
    { role: 'assistant', text: 'Then next session is interview prep. Until then: notepad at 4am, and the bar is surviving the reorg, not winning it.' },
    { role: 'user', text: 'Surviving, not winning. I need that on a sticky note.' },
  ],
];

export const SANDBOX_PERSONAS: SandboxPersona[] = [
  {
    handle: 'avery',
    archetype: 'improving_anxiety',
    weeks: [7, 10],
    sessions: [5, 7],
    moodArc: 'improving',
    mood: { start: 4, end: 7 },
    phq2: { start: 3, end: 1 },
    gad2: { start: 5, end: 2 },
    topics: ['work anxiety', 'presentations', 'catastrophizing', 'sleep'],
    techniques: ['worry window', 'thought record', 'evidence list', 'paced breathing'],
    headlines: [
      'Sunday-night dread easing with worry-window practice',
      'Presentation went fine; catastrophe chain broke at step one',
      'Evidence list becoming a pre-meeting anchor',
    ],
    followUps: ['Review evidence-list entries', 'Plan Sunday-evening ritual', 'Check worry-window adherence'],
    soap: {
      subjective: [
        'Client reports reduced anticipatory anxiety before work meetings; Sunday nights remain the hardest window.',
        'Client describes a successful presentation despite a pre-event spiral; surprised by the gap between prediction and outcome.',
      ],
      objective: [
        'Engaged and reflective; completed worry-window practice twice this week and reported outcomes accurately.',
        'Used the thought-record structure with minimal prompting; affect brighter than prior sessions.',
      ],
      assessment: [
        'Anxiety symptoms trending down; client increasingly able to treat anxious predictions as hypotheses rather than facts.',
        'Skill acquisition is generalizing from sessions to workplace situations. Non-diagnostic, descriptive only.',
      ],
      plan: [
        'Continue worry-window practice; add evidence-list review before high-stakes meetings.',
        'Introduce a Sunday-evening wind-down ritual; review at next session.',
      ],
    },
    caseNotes: [
      'Phone check-in re: benefits paperwork. Client engaged, mood self-reported as improving. No safety concerns raised.',
      'Coordinated with employer EAP about workload accommodation window. Client consented to the outreach.',
    ],
    practice: [
      { title: 'Evidence list', description: 'Log moments when an anxious prediction did not come true. One line each.', kind: 'worksheet' },
      { title: 'Worry window', description: 'Fifteen minutes of scheduled worry time before dinner. Park worries until then.', kind: 'exercise' },
    ],
    showcase: IMPROVING_ANXIETY_SHOWCASE,
  },
  {
    handle: 'marisol',
    archetype: 'crisis_recovery',
    crisis: true,
    weeks: [6, 9],
    sessions: [4, 6],
    moodArc: 'improving',
    mood: { start: 2, end: 5 },
    phq2: { start: 6, end: 3 },
    gad2: { start: 4, end: 3 },
    topics: ['grief', 'anniversary reaction', 'sleep', 'guilt'],
    techniques: ['safety planning', 'paced breathing', 'behavioral activation', 'support activation'],
    headlines: [
      'Anniversary week survived with sister present; dark thoughts quieted',
      'Passive ideation disclosed and safety plan built in session',
      'Grief moving in waves; sleep still disrupted',
    ],
    followUps: ['Check safety plan use', 'Plan ahead for the next hard date', 'Monitor sleep'],
    soap: {
      subjective: [
        'Client disclosed passive suicidal ideation without plan or intent, tied to an approaching anniversary. Reports severe sleep disruption.',
        'Client reports the anniversary passed with sister present; denies ideation this week and describes a felt shift.',
      ],
      objective: [
        'Tearful but engaged; answered direct risk questions openly; agreed to and co-built a safety plan.',
        'Calmer presentation; spontaneously referenced safety-plan elements; affect congruent with grief rather than despair.',
      ],
      assessment: [
        'Acute grief with passive ideation, no plan or intent or access to means; risk mitigated by engaged support (sister) and safety plan. Escalated to care team per protocol.',
        'De-escalating trajectory; protective factors strengthening. Continued monitoring warranted around significant dates.',
      ],
      plan: [
        'Safety plan active; care team notified; daily check-in encouraged through the anniversary window.',
        'Pre-build a coping plan for the next significant date; continue paced breathing at night.',
      ],
    },
    caseNotes: [
      'Safety check call completed. Client reports using the safety plan Tuesday night; sister stayed over. Follow-up scheduled.',
      'Referral submitted for a local grief support group; shared meeting schedule with client. Client receptive.',
    ],
    practice: [
      { title: 'Paced breathing before bed', description: 'Four counts in, six counts out, five minutes, lights low.', kind: 'exercise' },
      { title: 'Night-time plan card', description: 'Keep the safety plan card on the nightstand. Note each time it gets used.', kind: 'observation' },
    ],
    safetyPlan: {
      warning_signs: ['Night-time rumination about the loss', 'Skipping meals', 'Avoiding calls from family'],
      coping_strategies: ['Step outside for cold air', 'Paced breathing (4-in, 6-out)', 'Photo album with sister, not alone'],
      support_contacts: ['Sister (first call, any hour)', 'Care team via the app'],
      reasons_worth_living: ['Sister and nephew', 'Finishing the garden he started'],
      professional_resources: ['988 Suicide & Crisis Lifeline (call/text 988)', 'Crisis Text Line (text HOME to 741741)'],
    },
    showcase: CRISIS_SHOWCASE,
  },
  {
    handle: 'theo',
    archetype: 'burnout_continuity',
    weeks: [8, 10],
    sessions: [6, 8],
    moodArc: 'improving',
    mood: { start: 3, end: 6 },
    phq2: { start: 4, end: 2 },
    gad2: { start: 3, end: 2 },
    topics: ['burnout', 'work boundaries', 'sleep quality', 'identity outside work'],
    techniques: ['boundary experiments', 'urgency triage question', 'behavioral activation'],
    headlines: [
      'Email cutoff experiment: two of three nights, sleep visibly better',
      'Reclaimed evenings going to fiction; first book in a year',
      'One-question urgency triage adopted for late messages',
    ],
    followUps: ['Extend cutoff to five nights', 'Protect Saturday morning', 'Track morning energy'],
    soap: {
      subjective: [
        'Client reports chronic exhaustion with non-restorative sleep; identifies late-night email as the last activity most nights.',
        'Client reports better sleep on boundary nights and a returning sense of identity outside work.',
      ],
      objective: [
        'Completed two of three planned email-cutoff nights; accurately self-observed the lapse trigger.',
        'Energetic in session relative to baseline; humor returning; concrete about next experiments.',
      ],
      assessment: [
        'Burnout pattern maintained by boundary erosion; responding well to small reversible experiments. Descriptive, non-diagnostic.',
        'Progress stable across multiple weeks; relapse risk around perceived-urgent work threads.',
      ],
      plan: [
        'Extend email cutoff; introduce Saturday-morning protected block; continue book habit.',
        'Review urgency-triage question use at next session.',
      ],
    },
    caseNotes: [
      'Contact re: short-term disability paperwork question. Provided form links; no clinical concerns raised.',
      'Coordination with primary care about fatigue workup completed at client request.',
    ],
    practice: [
      { title: 'Email cutoff at 8pm', description: 'Three nights this week, laptop closed at 8pm. Note sleep quality next morning.', kind: 'observation' },
      { title: 'Twenty pages of fiction', description: 'Replace one inbox session with twenty pages of the current novel.', kind: 'exercise' },
    ],
    showcase: BURNOUT_SHOWCASE,
  },
  {
    handle: 'noor',
    archetype: 'brand_new',
    weeks: [1, 2],
    sessions: [1, 2],
    moodArc: 'flat',
    mood: { start: 4, end: 5 },
    phq2: { start: 3, end: 3 },
    gad2: { start: 2, end: 2 },
    topics: ['relocation', 'loneliness', 'evening routine'],
    techniques: ['tiny habit swap', 'behavioral activation'],
    headlines: [
      'Intake: post-move heaviness, thin local support net',
      'Second session: walk habit landing four of seven days',
    ],
    followUps: ['Check walk streak', 'Follow up on climbing-gym invitation'],
    soap: {
      subjective: [
        'New client, two months post-relocation; reports pervasive heaviness and social isolation. No risk language.',
        'Client reports partial success with the walk experiment and a pending social invitation from a coworker.',
      ],
      objective: [
        'Guarded initially, warmed over the session; agreed to one small behavioral experiment.',
        'Reported outcomes concretely; ambivalence about social exposure named without prompting.',
      ],
      assessment: [
        'Adjustment-related low mood in the context of relocation; engaged and experiment-willing. Descriptive only.',
        'Early trajectory promising; social re-connection is the active thread.',
      ],
      plan: [
        'Ten-minute pre-phone walk daily; observe without grading.',
        'Support a time-limited yes to the coworker invitation; debrief next session.',
      ],
    },
    caseNotes: [
      'Intake logistics call: confirmed contact preferences and app setup. Client oriented and engaged.',
    ],
    practice: [
      { title: 'Ten-minute walk before phone', description: 'Walk first, scroll later. Ten minutes counts.', kind: 'exercise' },
    ],
    showcase: NEW_INTAKE_SHOWCASE,
  },
  {
    handle: 'gideon',
    archetype: 'flat_maintenance',
    weeks: [6, 9],
    sessions: [4, 6],
    moodArc: 'flat',
    mood: { start: 5, end: 6 },
    phq2: { start: 3, end: 2 },
    gad2: { start: 2, end: 2 },
    topics: ['anhedonia', 'routine', 'hobbies', 'mornings'],
    techniques: ['no-stakes re-entry', 'morning anchor', 'behavioral activation'],
    headlines: [
      'Five bad minutes of guitar became thirty good ones',
      'Days blurring; chasing texture, not performance',
      'Bakery mornings added as a second anchor',
    ],
    followUps: ['Keep guitar streak', 'Bakery twice this week', 'Watch morning negotiation'],
    soap: {
      subjective: [
        'Client describes emotional flatness and undifferentiated days; identifies abandoned guitar practice as a lost anchor.',
        'Client reports renewed evening anticipation after low-stakes guitar re-entry; mornings remain effortful.',
      ],
      objective: [
        'Flat affect early in session; visibly animated when discussing music.',
        'Followed through on the playing-badly-on-purpose frame; reported two extended practice sessions.',
      ],
      assessment: [
        'Anhedonic pattern responding to graded re-engagement with previously valued activities. Non-diagnostic.',
        'Momentum building on evenings; mornings are the next target.',
      ],
      plan: [
        'Maintain five-minute guitar floor; add a pleasant morning anchor.',
        'Review both anchors and overall day texture next session.',
      ],
    },
    caseNotes: [
      'Check-in call: no changes in housing or benefits status. Client stable, keeping appointments.',
    ],
    practice: [
      { title: 'Five bad minutes', description: 'Play guitar badly on purpose for five minutes, three evenings.', kind: 'exercise' },
      { title: 'Morning anchor log', description: 'Note what got you vertical each morning. No judgment, just data.', kind: 'observation' },
    ],
    showcase: FLAT_SHOWCASE,
  },
  {
    handle: 'petra',
    archetype: 'declining',
    weeks: [5, 8],
    sessions: [4, 6],
    moodArc: 'declining',
    mood: { start: 6, end: 3 },
    phq2: { start: 2, end: 4 },
    gad2: { start: 3, end: 5 },
    topics: ['reorg stress', 'job insecurity', '4am wake-ups', 'irritability'],
    techniques: ['load shedding', 'worry dump', 'stimulus control'],
    headlines: [
      'Reorg double-load: 4am wake-ups and short fuse at home',
      'Newsletter paused, nobody blinked; interview in twelve days',
      'Worry-dump notepad replacing 4am rehearsal loop',
    ],
    followUps: ['Interview prep next session', 'Notepad at 4am', 'Check partner conversation'],
    soap: {
      subjective: [
        'Client reports escalating work stress under a reorg, early-morning awakening, and irritability at home.',
        'Client shed one obligation and disclosed the stress to partner; sleep still fragmented.',
      ],
      objective: [
        'Pressured speech when describing workload; receptive to concrete load-shedding options.',
        'Followed through on one of two experiments; realistic about partial adherence.',
      ],
      assessment: [
        'Stress response trending worse under sustained occupational threat; monitoring screeners weekly. Descriptive only.',
        'Protective steps beginning; trajectory needs close watching until the interview resolves.',
      ],
      plan: [
        'Worry-dump notepad at the nightstand; interview prep scheduled; screeners weekly.',
        'Escalate to care team if sleep or mood worsens further.',
      ],
    },
    caseNotes: [
      'Client flagged rising stress at check-in; encouraged use of scheduled session and shared screener trend with care team.',
      'Coordinated a benefits question with HR contact at client request. No safety concerns; monitoring trend.',
    ],
    practice: [
      { title: 'Worry dump at 4am', description: 'Notepad on the nightstand. If awake, write every worry down, then back to bed.', kind: 'exercise' },
      { title: 'One thing off the plate', description: 'Name one obligation to pause this week and send the email.', kind: 'custom' },
    ],
    showcase: DECLINING_SHOWCASE,
  },
  {
    handle: 'silas',
    archetype: 'improving_anxiety',
    weeks: [6, 9],
    sessions: [4, 6],
    moodArc: 'improving',
    mood: { start: 4, end: 6 },
    phq2: { start: 2, end: 1 },
    gad2: { start: 5, end: 3 },
    topics: ['panic', 'commuting', 'body sensations', 'avoidance'],
    techniques: ['interoceptive familiarity', 'paced breathing', 'graded exposure'],
    headlines: [
      'Two train rides completed with early-wave breathing',
      'Panic reframed as a false alarm that peaks and passes',
      'Avoidance radius shrinking week over week',
    ],
    followUps: ['Extend the train route one stop', 'Log wave peaks', 'Keep breathing practice daily'],
    soap: {
      subjective: [
        'Client reports two completed train commutes using breathing at the first wave of symptoms; pride evident.',
        'Client describes panic sensations as familiar rather than dangerous; avoidance shrinking.',
      ],
      objective: [
        'Described symptom waves with accurate observation; no safety behaviors reported on completed rides.',
        'Engaged in exposure planning; self-selected the next step.',
      ],
      assessment: [
        'Panic-pattern avoidance yielding to graded exposure; self-efficacy climbing. Non-diagnostic.',
        'Steady trajectory; relapse risk if a ride goes badly without a debrief.',
      ],
      plan: [
        'One additional stop on the route this week; debrief any hard ride within a day.',
        'Maintain daily breathing practice as the baseline skill.',
      ],
    },
    caseNotes: [
      'Transportation benefit question resolved; client attending in-person appointments again.',
    ],
    practice: [
      { title: 'One more stop', description: 'Ride one stop past the usual exit, then return. Log the peak of the wave.', kind: 'exercise' },
    ],
    showcase: IMPROVING_ANXIETY_SHOWCASE,
  },
  {
    handle: 'wren',
    archetype: 'flat_maintenance',
    weeks: [7, 10],
    sessions: [5, 7],
    moodArc: 'flat',
    mood: { start: 5, end: 5 },
    phq2: { start: 2, end: 2 },
    gad2: { start: 3, end: 3 },
    topics: ['caregiving', 'guilt', 'respite', 'routine'],
    techniques: ['respite scheduling', 'values check', 'self-compassion break'],
    headlines: [
      'Caregiving load steady; guilt around taking respite',
      'First scheduled respite afternoon taken without cancelling',
      'Values check: being rested IS caring for him',
    ],
    followUps: ['Protect the respite slot', 'Watch guilt spikes', 'Check sibling support ask'],
    soap: {
      subjective: [
        'Client maintains a heavy caregiving schedule; reports guilt as the barrier to accepting respite.',
        'Client took a first respite afternoon; guilt spiked then subsided; energy better for two days after.',
      ],
      objective: [
        'Steady affect; thoughtful engagement with the values reframe.',
        'Kept the respite commitment made last session; reported honestly on the guilt curve.',
      ],
      assessment: [
        'Stable mood under sustained load; sustainability depends on respite becoming routine. Descriptive only.',
        'Guilt responding to values-based reframing; trend stable.',
      ],
      plan: [
        'Standing weekly respite slot; draft the support ask to sibling.',
        'Monitor for load creep; screeners biweekly.',
      ],
    },
    caseNotes: [
      'Arranged respite-care resource list and shared eligibility details. Client will review with family.',
      'Follow-up on home-support application; documents submitted. Client relieved.',
    ],
    practice: [
      { title: 'Respite afternoon', description: 'One protected afternoon. No errands allowed to colonize it.', kind: 'exercise' },
    ],
    showcase: FLAT_SHOWCASE,
  },
  {
    handle: 'dario',
    archetype: 'burnout_continuity',
    weeks: [8, 10],
    sessions: [5, 7],
    moodArc: 'improving',
    mood: { start: 3, end: 5 },
    phq2: { start: 4, end: 3 },
    gad2: { start: 4, end: 2 },
    topics: ['shift work', 'sleep debt', 'isolation', 'meals'],
    techniques: ['sleep window anchoring', 'meal regularity', 'micro-connection'],
    headlines: [
      'Sleep window anchored despite rotating shifts',
      'One real meal a day became three most days',
      'Texted an old friend back after months',
    ],
    followUps: ['Hold the sleep anchor through next rotation', 'Keep meal floor', 'Plan one call with the friend'],
    soap: {
      subjective: [
        'Client on rotating shifts reports chronic sleep debt and skipped meals; socially withdrawn.',
        'Client reports anchored wake window across the rotation and renewed contact with a friend.',
      ],
      objective: [
        'Fatigued presentation; concrete and willing on schedule redesign.',
        'Brighter affect; laughed for the first time in sessions when describing the friend exchange.',
      ],
      assessment: [
        'Shift-work strain compounding mood; foundational habits are the lever. Non-diagnostic.',
        'Foundations improving; social re-connection beginning.',
      ],
      plan: [
        'Protect the wake-window anchor; keep the three-meal floor; schedule the friend call.',
        'Review after next rotation completes.',
      ],
    },
    caseNotes: [
      'Employment coordination: confirmed schedule accommodation request was received by the supervisor.',
    ],
    practice: [
      { title: 'Wake-window anchor', description: 'Same wake anchor across shifts, within one hour. Log it.', kind: 'observation' },
    ],
    showcase: BURNOUT_SHOWCASE,
  },
  {
    handle: 'lena',
    archetype: 'declining',
    weeks: [5, 8],
    sessions: [4, 6],
    moodArc: 'declining',
    mood: { start: 5, end: 3 },
    phq2: { start: 3, end: 5 },
    gad2: { start: 2, end: 4 },
    topics: ['breakup', 'rumination', 'appetite', 'withdrawal'],
    techniques: ['rumination interruption', 'social floor', 'behavioral activation'],
    headlines: [
      'Post-breakup rumination loops lengthening; appetite down',
      'Social floor set: one human contact a day, however small',
      'Screener trend worsening; care team watching closely',
    ],
    followUps: ['Daily contact floor check', 'Appetite watch', 'Screeners weekly'],
    soap: {
      subjective: [
        'Client reports intensifying rumination and reduced appetite following a breakup; withdrawing from friends. Denies ideation on direct inquiry.',
        'Client kept the one-contact-a-day floor most days; mood still trending down; sleep variable.',
      ],
      objective: [
        'Subdued affect, longer response latencies; engaged when structure offered.',
        'Adherence partial but honest; accepted increased screener cadence.',
      ],
      assessment: [
        'Declining mood trajectory post-loss; no risk language, monitoring intensified. Descriptive only.',
        'Trend still negative; threshold for care-team escalation defined and shared with client.',
      ],
      plan: [
        'Maintain contact floor; weekly screeners; escalate on further decline or any risk language.',
        'Coordinate with care team on check-in frequency.',
      ],
    },
    caseNotes: [
      'Wellness check call: client low but engaged, eating small regular meals. Agreed to keep next appointment.',
      'Flagged worsening screener trend to the care team; increased check-in cadence to twice weekly.',
    ],
    practice: [
      { title: 'One contact a day', description: 'Any human contact counts: a text, a hello, a call. Log it.', kind: 'observation' },
    ],
    showcase: DECLINING_SHOWCASE,
  },
];

// Sanity: seeding always includes the crisis persona plus the brand-new one
// so every sandbox demos the crisis surfaces and an "empty" client.
export const CRISIS_PERSONA_HANDLE = 'marisol';
export const BRAND_NEW_PERSONA_HANDLE = 'noor';
