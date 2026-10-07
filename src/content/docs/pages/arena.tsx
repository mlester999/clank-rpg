import { Callout, DocH2, DocLink } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function Arena() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="eight-heroes-one-survivor">Eight heroes, one survivor</DocH2>
      <p>
        Every battle puts <strong>{r.arena.heroesPerBattle} heroes</strong> on the same stage at once. It is a free-for-all: each hero fights whoever it chooses, and the <strong>last hero standing wins</strong>. The
        rest are ranked by how long they lasted and how well they fought.
      </p>

      <DocH2 id="the-flow">The flow of a battle</DocH2>
      <ol>
        <li><strong>Idle.</strong> The heroes drop onto the stage and wait.</li>
        <li><strong>Countdown.</strong> A {r.arena.countdownSeconds}-second 3 · 2 · 1.</li>
        <li><strong>Combat.</strong> The heroes fight — no controls, no input from anyone.</li>
        <li><strong>Result.</strong> The winner and the finishing order are shown for about {r.arena.resultsSeconds} seconds.</li>
        <li><strong>Next battle.</strong> The next eight heroes step in, and it starts again.</li>
      </ol>
      <p>Battles follow each other without a break, all day. Heroes are drawn from everyone who is eligible, in rotation.</p>

      <DocH2 id="the-time-limit">The time limit</DocH2>
      <p>
        A battle lasts <strong>at most {r.arena.maxCombatSeconds} seconds</strong>. Most fights finish naturally well before that — typically somewhere around {r.arena.typicalFightSeconds.from} to {r.arena.typicalFightSeconds.to} seconds,
        when only one hero is left. Late in a long fight the arena enters <em>overtime</em>: damage slowly rises so a stalemate can&apos;t drag on.
      </p>
      <p>If the time limit is reached with more than one hero still standing, the hero with the most health left is ranked first.</p>

      <DocH2 id="one-global-arena">One global Arena</DocH2>
      <p>
        There is one Arena, and everybody watches the same battle at the same moment. It runs on a shared clock, so when you open the page you join the battle that is happening right now — not a recording and not
        your own private copy.
      </p>

      <DocH2 id="decided-on-the-server">Decided on the server</DocH2>
      <p>
        Battles are <strong>server-authoritative</strong>: the result is worked out on the game&apos;s servers, never in your browser, so nobody can change an outcome. Each battle is also <strong>deterministic and
        replayable</strong> — the same lineup and the same fight settings always play out the same way, which is what lets a past fight be checked and replayed exactly as it happened.
      </p>
      <Callout title="Nothing to operate">
        You don&apos;t control anything during a battle. Your hero fights for itself, and your part is to watch — and to <DocLink to="/docs/arena-picks">Pick</DocLink> the next winner.
      </Callout>
    </>
  );
}
