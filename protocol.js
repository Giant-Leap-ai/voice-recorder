// The whisper recording protocol as data (docs/WHISPER_RECORDING.md). Edit here, not in app.js.

export const CONFIG = {
  recipient: "luke@onegiantleap.ai",
  protocolVersion: "whisper-v1",
  consentVersion: "v1",
};

export const CONSENT = {
  required:
    "I agree to these recordings being used for Luke's speech research project. Results may be published; my name won't be. I can ask for my recordings to be deleted at any time.",
  release: "I also agree to my recordings being released publicly for research under CC BY 4.0.",
};

export const VOICES = {
  normal: {
    label: "Normal voice",
    how: "Your everyday speaking voice, as if dictating a message.",
    check: null,
  },
  whisper: {
    label: "Whisper",
    how: "A true whisper with no voice at all, as if someone is asleep in the next room. Not a stage whisper.",
    check: "Rest two fingers on your throat: you should feel no buzz.",
  },
  library: {
    label: "Library voice",
    how: "Quiet but voiced, as if talking to someone next to you in a library.",
    check: "Rest two fingers on your throat: you should feel a buzz.",
  },
  far: {
    label: "Normal voice, from across the room",
    how: "Your normal voice. Don't raise it to reach the phone, and don't whisper.",
    check: null,
  },
};

const HARVARD = {
  1: [
    "The birch canoe slid on the smooth planks.",
    "Glue the sheet to the dark blue background.",
    "It's easy to tell the depth of a well.",
    "These days a chicken leg is a rare dish.",
    "Rice is often served in round bowls.",
    "The juice of lemons makes fine punch.",
    "The box was thrown beside the parked truck.",
    "The hogs were fed chopped corn and garbage.",
    "Four hours of steady work faced us.",
    "A large size in stockings is hard to sell.",
  ],
  2: [
    "The boy was there when the sun rose.",
    "A rod is used to catch pink salmon.",
    "The source of the huge river is the clear spring.",
    "Kick the ball straight and follow through.",
    "Help the woman get back to her feet.",
    "A pot of tea helps to pass the evening.",
    "Smoky fires lack flame and heat.",
    "The soft cushion broke the man's fall.",
    "The salt breeze came across from the sea.",
    "The girl at the booth sold fifty bonds.",
  ],
  3: [
    "The small pup gnawed a hole in the sock.",
    "The fish twisted and turned on the bent hook.",
    "Press the pants and sew a button on the vest.",
    "The swan dive was far short of perfect.",
    "The beauty of the view stunned the young boy.",
    "Two blue fish swam in the tank.",
    "Her purse was full of useless trash.",
    "The colt reared and threw the tall rider.",
    "It snowed, rained, and hailed the same morning.",
    "Read verse out loud for pleasure.",
  ],
};

export const SCRIPTS = {
  S1: "Hey Sam, quick update on Thursday. The venue moved to the second floor, so take the elevator by the coffee shop. We start at six thirty, and I'll save you a seat near the back.",
  S2: "Reminder to myself: call the dentist before noon, pick up the dry cleaning, and move the budget meeting to Friday at ten. Also check whether the parking pass expires this month.",
  S3: "Notes on the bookshelf project. Measure the alcove again, it's probably eighty-four centimeters wide. Buy four brackets, a box of screws, and sandpaper. Paint it white unless the wood looks good.",
  S4: "Hi Priya, thanks for sending the draft. The first section reads well. I'd cut the second paragraph in half and move the chart up front. Can we talk it through tomorrow morning?",
  S5: "Grocery list: oat milk, two lemons, a bag of rice, spinach, eggs, and something for dessert. Maybe the dark chocolate with sea salt. Don't forget the recycling bags.",
  S6: "Idea for the weekend: rent bikes, ride the river path north to the old bridge, and have lunch at that taco place. If it rains, we could do the museum instead and get dinner after.",
  S7: "Text to Mom: landed safely, waiting for my bag. The flight was smooth but we left forty minutes late. I'll call you once I'm at the hotel, probably around nine.",
  S8: "Meeting agenda: hiring update, the quarterly numbers, and a decision on the new office chairs. Ask Jordan to bring the vendor quotes. Keep it under thirty minutes.",
  S9: "Recipe note: brown the onions slowly, then add garlic, cumin and a pinch of chili. Stir in the tomatoes, simmer for twenty minutes, and finish with lime juice and coriander.",
};

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const enrollClips = (sentences, size) =>
  chunks(sentences, size).map((group, i) => ({
    id: `e${String(i + 1).padStart(2, "0")}`,
    text: group.join(" "),
    lines: group,
  }));

const scriptClips = (ids) => ids.map((id) => ({ id, text: SCRIPTS[id], lines: [SCRIPTS[id]] }));

// mode: "silence" (timed, no speech), "clip" (one recording per clip, tap to start/stop),
// "far" (hands-free: one continuous recording, timed prompts, sync beeps).
export const TAKES = [
  { id: "W0", title: "Room check", voice: null, mode: "silence", seconds: 10,
    intro: "Hold the phone in position and stay silent for 10 seconds. This measures how quiet the room is." },
  { id: "W1", title: "Enrollment, normal voice", voice: "normal", mode: "clip",
    intro: "Read each group of sentences at a natural pace, with a short pause between sentences.",
    clips: enrollClips([...HARVARD[1], ...HARVARD[2]], 5) },
  { id: "W2", title: "Enrollment, whispered", voice: "whisper", mode: "clip",
    intro: "The same kind of sentences, whispered.",
    clips: enrollClips(HARVARD[3], 5) },
  { id: "W3", title: "Scripts, normal voice", voice: "normal", mode: "clip",
    intro: "Read each message the way you'd dictate it.",
    clips: scriptClips(["S1", "S2", "S3", "S4", "S5", "S6"]) },
  { id: "W4", title: "Scripts, whispered", voice: "whisper", mode: "clip",
    intro: "The same six messages, whispered. Keep the phone at the same distance; people tend to bring it closer when whispering.",
    clips: scriptClips(["S1", "S2", "S3", "S4", "S5", "S6"]) },
  { id: "W5", title: "Scripts, library voice", voice: "library", mode: "clip",
    intro: "Three new messages, in a quiet but voiced library voice.",
    clips: scriptClips(["S7", "S8", "S9"]) },
  { id: "W6", title: "From across the room", voice: "far", mode: "far",
    intro: "Lay the phone flat on a table, screen up, bottom edge pointing toward where you'll sit. Then sit or stand 1.5 to 2 metres away, facing it. The sentences appear one at a time in large type; read each one in your normal voice. If you can't read the screen from there, use a printed copy of messages S1 to S6.",
    clips: scriptClips(["S1", "S2", "S3", "S4", "S5", "S6"]) },
];

// Flat list of everything that produces a file, in order.
export function allClips() {
  const out = [];
  for (const t of TAKES) {
    if (t.mode === "silence") out.push({ take: t.id, clipId: "room", key: `${t.id}_room`, voice: null, text: "" });
    else if (t.mode === "far") out.push({ take: t.id, clipId: "take", key: `${t.id}_take`, voice: t.voice, text: t.clips.map((c) => c.text).join(" ") });
    else for (const c of t.clips) out.push({ take: t.id, clipId: c.id, key: `${t.id}_${c.id}`, voice: t.voice, text: c.text });
  }
  return out;
}
