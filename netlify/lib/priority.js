// Shared priority-lane detection. Used by submit.js and by the seed action.
//
// NOTHING HERE REJECTS ANYTHING. A match only sorts the entry to the top of the
// review queue with a red READ FIRST badge. The wrestler sees no difference at all.
//
// Because a hit is cheap (three extra seconds of your reading) and a miss is not,
// this list errs toward catching too much. It is still crude: it cannot read tone,
// context, or anything phrased in a way nobody thought to list. The actual safety
// net is that you read every entry before it goes up. This just decides the order.

export const PRIORITY_TERMS = [
  // self harm and suicidal thinking
  'kill myself','kill my self','killing myself','kms','end my life','end it all',
  'want to die','wanna die','rather die','wish i was dead','wish i were dead',
  'better off dead','dont want to be here',"don't want to be here",
  'suicide','suicidal','hurt myself','hurting myself','cut myself','cutting myself',
  'self harm','selfharm','hate myself','hate my life','worthless','no point',
  'pointless','nobody cares','no one cares','tired of living','cant go on',"can't go on",
  'give up on everything','nothing matters',

  // disordered eating and unsafe weight cutting
  'starve','starving','not eating','stopped eating','havent eaten',"haven't eaten",
  'throw up','throwing up','threw up','purge','purging','laxative','diuretic',
  'water weight','sauna suit','spit weight','cut weight','cutting weight','weight cut',
  'pull weight','anorexi','bulimi','too fat','so fat','disgusting',

  // abuse, hazing, fear of adults
  'hits me','hit me','punched me','grabbed me','touched me','abuse','abusive',
  'hazing','hazed','bullied','bullying','scared of my coach','screams at me',
  'yells at me','afraid to go',

  // injuries being hidden to keep competing
  'concussion','concussed','hiding my injury','hurt my neck','blacked out','passed out',
  'cant feel',"can't feel"
];

// Short, high-risk words matched on word boundaries rather than as substrings,
// so `die` does not fire on `diet` and `fat` does not fire on `fatigue`.
export const PRIORITY_WORDS = [
  'die','dies','died','dying','dead','death','suicide','cutting','purge','purged',
  'starve','starved','fat','fasting','anorexic','bulimic','hopeless','alone','quit'
];

const WORD_RE = new RegExp('\\b(' + PRIORITY_WORDS.join('|') + ')\\b', 'i');

export function isPriority(text) {
  const s = String(text).toLowerCase();
  if (PRIORITY_TERMS.some(term => s.includes(term))) return true;
  return WORD_RE.test(s);
}
