import { Callout, DocH2, DocLink } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function GettingStarted() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="the-community">The community</DocH2>
      <p>
        Clank RPG heroes come from one place only: the official <strong>{r.community.name} Telegram community</strong>. There is no sign-up form and no way to buy a hero. If you are part of the community
        and you take part in the conversation, you are already on your way.
      </p>

      <DocH2 id="becoming-eligible">Becoming eligible</DocH2>
      <p>
        You become eligible once you have sent <strong>{r.community.telegramThreshold} qualifying messages</strong> in the official community. After that, a hero is created for you automatically — you
        don&apos;t apply for it and there is nothing to claim.
      </p>
      <p>
        To use your hero on the site — see it on your Character page and make Arena Picks — <strong>sign in with Telegram</strong>. Signing in only proves that the Telegram account is yours; the game never
        asks for your phone number, a password or a wallet.
      </p>

      <DocH2 id="qualifying-messages">Qualifying messages</DocH2>
      <p>
        Not every message counts toward your {r.community.telegramThreshold}. A <strong>qualifying message</strong> is a real contribution to the conversation. Spam, floods, copy-pasted text, one-word
        filler, forwarded content and link-dropping don&apos;t count — so being loud is not the same as being eligible.
      </p>
      <Callout title="Why the exact rules aren't published">
        The checks that decide what qualifies exist to keep the game fair for everyone. Publishing every detail would only help people game them, so the docs describe the idea, not the internals.
      </Callout>

      <DocH2 id="your-hero-appears">Your hero appears</DocH2>
      <p>When you reach the threshold (and your account is in good standing) your hero is generated for you:</p>
      <ul>
        <li><strong>Class</strong> — one of {r.hero.classCount}. Your chat habits nudge which one you get, but it is partly luck. See <DocLink to="/docs/classes">Classes</DocLink>.</li>
        <li><strong>Rarity</strong> — drawn with fixed odds. See <DocLink to="/docs/rarity">Rarity</DocLink>.</li>
        <li><strong>Stats and PWR</strong> — built from the rarity and class. See <DocLink to="/docs/power-and-stats">Power &amp; stats</DocLink>.</li>
        <li><strong>A look</strong> — a unique appearance that fits the class and shows off the rarity.</li>
      </ul>
      <p>
        From that moment your hero is in the Arena rotation and fights on its own. You can find it in the <DocLink to="/heroes">Heroes directory</DocLink>, and it has its own public page you can share.
      </p>

      <DocH2 id="fair-play">Fair play</DocH2>
      <p>
        Moderation and anti-abuse rules apply to everyone. Accounts that abuse the community or the game can have their hero suspended and their rewards held for review, and the team makes the final call.
        If something looks wrong with your hero or your account, ask in the official community.
      </p>
    </>
  );
}
