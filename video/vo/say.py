# One source of truth for the narrated pitch: the script, the voice, the timing,
# the subtitles. Every timestamp is measured from the rendered audio, not guessed.
#
#   python vo/say.py      (from video/)
#
# Writes public/vo/<hash>.mp3 (one clip per sentence, cached), src/timeline.json
# (what Remotion renders), ../media/talang-pitch.srt + .vtt, ../docs/pitch-narration.md.
# Also copies the deck shots and recordings it shows into public/ (gitignored).
# Then: npm run render (writes ../media/talang-pitch.mp4).
import asyncio, hashlib, json, os, re, shutil, subprocess

import edge_tts

VOICE = os.environ.get("VOICE", "en-US-AndrewMultilingualNeural")
RATE = "-5%"
FPS = 30
GAP = 0.25    # between sentences in a scene
LEAD = 0.35   # scene start -> first word
TAIL = 0.5   # last word -> scene end
MAX_FOOTAGE_RATE = 2.5  # never play a recording faster than this

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # video/
REPO = os.path.dirname(ROOT)

# How the synthetic voice should say a term; the subtitle keeps the written form.
SAY = [
    ("talang-desk.vercel.app", "talang desk dot vercel dot app"),
    ("github.com/PugarHuda/talang", "github dot com, slash Pugar Huda, slash talang"),
    ("CIP-0103", "C I P one oh three"), ("USDCx", "U S D C X"), ("USDC", "U S D C"),
    ("CBTC", "C B T C"), ("DecMan", "Dec Man"), ("DevNet", "Dev Net"), ("MainNet", "Main Net"),
    ("LocalNet", "Local Net"), ("NODERS", "Noders"), ("MCP", "M C P"), ("Daml", "Dammel"),
    ("update ID", "update I D"), ("0.001", "zero point zero zero one"), ("1.2.0", "one point two"),
    ("DA Utility", "D A Utility"), ("TestNet", "Test Net"),
]

def spoken(t):
    for a, b in SAY:
        t = t.replace(a, b)
    return t

# kind: slide (deck/shots/NN.png), desk / decman / grofty (segments of a recording,
# seconds from its .marks.json), card (drawn in Remotion from cards() below), close.
SCENES = [
    dict(id="title", kind="slide", slide="01", lines=[
        "This is Talang, a sealed-bid repo desk on Canton.",
    ]),
    dict(id="problem", kind="slide", slide="02", lines=[
        "Repo is how bond holders raise cash without selling.",
        "But asking five lenders for a price tells all five you need money.",
    ]),
    dict(id="what", kind="slide", slide="03", lines=[
        "On Talang, a quote goes to the borrower alone. Canton never sends it to a rival's node.",
    ]),
    dict(id="desk-request", kind="desk", segs=[[25.7, 41.6]], lines=[
        "Here's the desk, typed in live. The borrower asks three lenders for five point three million USDC against sixty Treasury notes.",
    ]),
    dict(id="desk-quote-a", kind="desk", segs=[[41.8, 63.0]], lines=[
        "Lender A types its rate and haircut, and seals the quote, with the cash locked behind it.",
        "Its node shows only its own quotes.",
    ]),
    dict(id="desk-quote-bc", kind="desk", segs=[[70.5, 81.6], [95.5, 111.6]], lines=[
        "Lender B quotes the lowest rate, with a six percent haircut. Lender C quotes four ninety-five, with three.",
    ]),
    dict(id="desk-award", kind="desk", segs=[[111.9, 128.5]], lines=[
        "The borrower sees three sealed quotes. B's is short at the mark, so it takes the cheapest one that covers.",
        "Cash and collateral move in one transaction.",
    ]),
    dict(id="desk-loss", kind="desk", segs=[[128.7, 140.5]], lines=[
        "Lender B learns its rank, nothing else. Since version 1.2.0, it isn't even an informee of the award.",
    ]),
    dict(id="desk-regulator", kind="desk", segs=[[140.7, 152.5]], lines=[
        "The regulator sees best execution: the winner ranked second on rate, and no lender is named.",
    ]),
    dict(id="desk-call", kind="desk", segs=[[177.6, 191.6], [193.0, 207.6]], lines=[
        "Then the valuation agent publishes a lower mark. Lender A's repo is now short, so it calls margin.",
    ]),
    dict(id="dm-committee", kind="decman", segs=[[0, 14.05]], lines=[
        "But one agent shouldn't set the mark alone. So a committee does: one decentralized party on three nodes, run through BitSafe's DecMan.",
        "Two of three must confirm.",
    ]),
    dict(id="dm-confirm", kind="decman", segs=[[14.05, 41.28]], lines=[
        "Node one proposes a markdown and confirms, which alone publishes nothing. Node two confirms in its own DecMan.",
    ]),
    dict(id="dm-execute", kind="decman", segs=[[41.28, 68.0]], lines=[
        "Execute, and the mark is published as the committee. Node three didn't vote, but its audit trail shows every step.",
    ]),
    dict(id="dm-margin", kind="decman", segs=[[68.0, 76.4]], lines=[
        "The lender calls margin with that mark. No single pricer could have moved it.",
    ]),
    dict(id="committee", kind="card", card="committee", lines=[
        "With one node stopped, the committee still published; with two, it couldn't.",
        "And the same flow ran on the NODERS DevNet participant.",
    ]),
    dict(id="release", kind="card", card="release", lines=[
        "Version 1.2.0 of the contract is now vetted there too.",
        "It adds a minimum transfer on margin calls, lender-signed haircut schedules, and a master agreement with close-out netting, all driven from the desk.",
    ]),
    dict(id="tokens", kind="card", card="tokens", lines=[
        "Both legs can be real tokens. On DevNet, a repo ran with Canton Coin cash and CBTC collateral, each allocated through its registry and settled at repurchase.",
    ]),
    dict(id="default", kind="card", card="default", lines=[
        "When a call on a stress mark went unanswered, the default ran too: 0.001 CBTC to lender A, through the DA Utility registry.",
    ]),
    dict(id="wallet", kind="grofty", segs=[[7.0, 17.6], [17.64, 28.0], [32.31, 38.5], [41.05, 56.0]], lines=[
        "The desk also connects to a real Grofty wallet on Canton TestNet.",
        "Each desk command is signed in Grofty and checked before it's submitted, and a one Canton Coin venue fee is paid from the wallet on TestNet.",
        "The signed Talang commands ran on a local sandbox, not yet on TestNet.",
    ]),
    dict(id="mcp", kind="slide", slide="09", lines=[
        "Each desk can have an AI agent over MCP. It reads only its own node, so a lender's agent never sees a rival's rate.",
    ]),
    dict(id="fee", kind="slide", slide="10", lines=[
        "The business is a venue fee, collected inside every repurchase and roll, so it can't be skipped. It's built, with no revenue yet.",
    ]),
    dict(id="next", kind="card", card="next", lines=[
        "Next: a two-week shadow book on DevNet, then small live repos on MainNet.",
        "Not done yet: USDCx, Talang commands on TestNet, and any pilot user.",
    ]),
    dict(id="close", kind="close", lines=[
        "That's Talang. The live desk and the code are on screen now.",
    ]),
]

FOOTAGE = {"desk": "talang-desk-typed.mp4", "decman": "decman-demo.mp4", "grofty": "grofty-wallet.mp4"}


def ev(name):
    return json.load(open(os.path.join(REPO, "docs", "evidence", name + ".json"), encoding="utf-8"))


def short(u):
    return f"{u[:12]}…{u[-4:]}"


def who(s):
    # The DevNet runs reused the Tirai parties on the NODERS participant.
    s = s.replace("ecaf163a-ecaf163a-tirai-dealerA", "lender A").replace("ecaf163a-ecaf163a-tirai-buyer", "borrower")
    s = s.replace(" -> ", " → ").replace("a Amulet", "an Amulet")
    return re.sub(r"(\d+\.\d*?)0+\b", r"\1", s)


def step_rows(d, skip=()):
    return [dict(l=who(x["step"]), r=short(x["updateId"]) if x.get("updateId") else "refused", bad=bool(x.get("refused")))
            for x in d["steps"]
            if (x.get("updateId") or x.get("refused")) and not any(k in x["step"] for k in skip)]


def cards():
    gov, tok, dft = ev("bitsafe-governed-marks-devnet"), ev("token-repo-amulet-cbtc-devnet"), ev("cbtc-default-devnet")
    off = ev("bitsafe-node-offline-localnet")
    one_down = next(x["updateId"] for x in off["steps"] if x.get("updateId"))
    tidy = [("STRESS SCENARIO mark", "stress mark"), ("; run PHASE=default after that", ""),
            (" (execute-transfer), allocation gone", ""), (" through the registry AllocationFactory", ", registry allocation"),
            (", published by the agent", ""), (" (not a market price)", "")]

    def tidied(s):
        for a, b in tidy:
            s = s.replace(a, b)
        s = re.sub(r"(\d{4}-\d\d-\d\d)T(\d\d:\d\d):[\d.]+Z", r"\1 \2 UTC", s)
        return who(s)

    return {
        "committee": dict(kicker="BitSafe valuation committee · NODERS DevNet", title="Two of three, ", hl="on DevNet too",
                          head=["STEP ON THE LEDGER", "UPDATE ID"], rows=step_rows(gov),
                          pill="LOCALNET", foot=f"One node stopped: still publishes ({short(one_down)}). Two: cannot.",
                          src=f"docs/evidence/bitsafe-governed-marks-devnet.json · {gov['ranAt'][:10]}"),
        "release": dict(kicker="talang-repo 1.2.0 · vetted on NODERS DevNet, 12 October", title="Repo terms, ", hl="enforced by the contract",
                        head=["ADDED IN 1.2.0", "DAML"], rows=[
                            dict(l="Sealed award: losing lenders are not informees", r="AwardSealed"),
                            dict(l="Minimum transfer amount on margin calls", r="Terms.minTransfer"),
                            dict(l="Lender-signed haircut schedules", r="HaircutSchedule"),
                            dict(l="Master agreement with close-out netting", r="MasterAgreement"),
                            dict(l="Desk: sign a schedule, set a minimum, offer, sign, close out", r="web/app.js"),
                        ],
                        pill="TESTED", foot="AgreementsTest and SecurityTest in Daml; desk QA on a local sandbox.",
                        src="package 5125df18…a3c366 · README.md"),
        "tokens": dict(kicker="Both legs in real tokens · NODERS DevNet", title="Canton Coin cash, ", hl="CBTC collateral",
                       head=["STEP ON THE LEDGER", "UPDATE ID"], rows=step_rows(tok, skip=("DevNet tap",)),
                       pill="NOT YET", foot="USDCx on DevNet: no registry there.",
                       src=f"docs/evidence/token-repo-amulet-cbtc-devnet.json · {tok['ranAt'][:10]}"),
        "default": dict(kicker="Default on DevNet · DA Utility registry", title="An unanswered call: ", hl="CBTC to the lender",
                        head=["STEP ON THE LEDGER", "UPDATE ID"],
                        rows=[dict(l=tidied(x["step"]), r=short(x["updateId"])) for x in dft["steps"] if x.get("updateId")],
                        pill="SCENARIO", foot="The stress mark is a scenario, not a market price.",
                        src=f"docs/evidence/cbtc-default-devnet.json · {dft['defaultedAt'][:10]}"),
        "next": dict(kicker="Roadmap", title="From a shadow book ", hl="to live repos",
                     head=["NEXT", "WHEN"], rows=[
                         dict(l="Shadow book on DevNet: one borrower, two lenders, no value moved", r="2 weeks"),
                         dict(l="Small live repos on MainNet: USDCx cash, capped tickets", r="4 weeks"),
                         dict(l="Committee run by independent price providers; an auditor's observer node", r="then"),
                     ],
                     pill="NOT YET", foot="USDCx on DevNet · a Talang command on TestNet · any pilot user.",
                     src="SUBMISSION.md"),
    }


def sync_assets():
    """Copy what the composition shows into public/ (gitignored)."""
    os.makedirs(os.path.join(ROOT, "public", "shots"), exist_ok=True)
    for f in sorted(os.listdir(os.path.join(REPO, "deck", "shots"))):
        shutil.copy2(os.path.join(REPO, "deck", "shots", f), os.path.join(ROOT, "public", "shots", f))
    for f in FOOTAGE.values():
        shutil.copy2(os.path.join(REPO, "media", f), os.path.join(ROOT, "public", f))


ROW = 42


def footage(sc):
    return sum(b - a for a, b in sc["segs"])

WEAK = {"a", "an", "the", "its", "of", "to", "as", "on", "at", "in", "and", "for", "with", "so", "is"}


def wrap(words, width):
    rows, cur = [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            rows.append(cur); cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        rows.append(cur)
    return rows


def balance(words):
    """Best split of one event's words into at most two rows of <= ROW chars."""
    text = " ".join(words)
    if len(text) <= ROW:
        return [text]
    best = None
    for k in range(1, len(words)):
        a, b = " ".join(words[:k]), " ".join(words[k:])
        if len(a) <= ROW and len(b) <= ROW:
            score = abs(len(a) - len(b)) - (12 if a[-1] in ",.:;?!" else 0)
            score += 10 if a.split()[-1].lower() in WEAK else 0
            if best is None or score < best[0]:
                best = (score, [a, b])
    return best[1] if best else None


def events_for(text):
    """Split a sentence into subtitle events: <= 2 rows, <= ROW chars a row.
    Returns [(first_word_index, rows)]."""
    words = text.split()
    n = len(words)
    # Few events, breaks after punctuation, no row ending on "a"/"the"/..., even lengths.
    best = {0: (0, 0.0, None)}
    for i in range(1, n + 1):
        for j in range(i):
            if j not in best or len(" ".join(words[j:i])) > 2 * ROW + 1 or balance(words[j:i]) is None:
                continue
            ev, cost, _ = best[j]
            rows = balance(words[j:i])
            brk = 0 if i == n or words[i - 1][-1] in ",.:;?!" else 10
            weak = 25 if len(rows) == 2 and rows[0].split()[-1].lower() in WEAK else 0
            cand = (0, cost + 20 + brk + weak + abs(len(" ".join(words[j:i])) - 60) / 30, j)
            if i not in best or cand[:2] < best[i][:2]:
                best[i] = cand
    if n not in best:
        raise SystemExit(f"cannot fit subtitle: {text!r}")
    cuts, i = [], n
    while i:
        j = best[i][2]
        cuts.append((j, balance(words[j:i])))
        i = j
    return cuts[::-1], n


def probe(path):
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).decode().strip())


async def synth(say, path):
    """Clip + word boundaries (seconds), cached by voice/rate/text."""
    meta = path + ".json"
    if os.path.exists(path) and os.path.exists(meta):
        return json.load(open(meta))
    c = edge_tts.Communicate(say, VOICE, rate=RATE, boundary="WordBoundary")
    words = []
    with open(path, "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                words.append([ch["offset"] / 1e7, (ch["offset"] + ch["duration"]) / 1e7])
    json.dump(words, open(meta, "w"))
    return words


def ts(t, sep):
    ms = max(0, round(t * 1000))
    h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{sep}{ms:03}"


async def main():
    sync_assets()
    outdir = os.path.join(ROOT, "public", "vo")
    os.makedirs(outdir, exist_ok=True)
    t = 0.0
    scenes, clips, subs = [], [], []
    for sc in SCENES:
        start = t
        at = start + LEAD
        for text in sc["lines"]:
            say = spoken(text)
            h = hashlib.md5(f"{VOICE}|{RATE}|{say}".encode()).hexdigest()[:12]
            path = os.path.join(outdir, f"{h}.mp3")
            words = await synth(say, path)
            dur = probe(path)
            spoken_end = words[-1][1]  # the mp3 carries ~0.4 s of trailing silence
            clips.append(dict(file=f"vo/{h}.mp3", start=at, dur=dur, text=text))
            evs, n_text = events_for(text)
            n_say = len(words)
            for i, (wi, rows) in enumerate(evs):
                si = min(n_say - 1, round(wi * n_say / n_text))
                s = at + (words[si][0] if i else 0)
                subs.append(dict(start=s, rows=rows, clipEnd=at + spoken_end))
            at += spoken_end + GAP
        end = at - GAP + TAIL
        if "segs" in sc:
            end = max(end, start + footage(sc) / MAX_FOOTAGE_RATE)
        scenes.append({**{k: v for k, v in sc.items() if k != "lines"}, "start": start, "dur": end - start})
        t = end

    # Each event lasts until the next one starts; across a scene cut it stops at
    # the end of its own clip (plus a beat), so text never sits over the next picture.
    for i, s in enumerate(subs):
        nxt = subs[i + 1]["start"] if i + 1 < len(subs) else t
        s["end"] = nxt if nxt - s["clipEnd"] < 0.6 else s["clipEnd"] + 0.3
        del s["clipEnd"]

    for sc in scenes:
        if "segs" in sc:
            sc["src"] = FOOTAGE[sc["kind"]]
    timeline = dict(fps=FPS, total=t, voice=VOICE, scenes=scenes, clips=clips, subs=subs, cards=cards())
    json.dump(timeline, open(os.path.join(ROOT, "src", "timeline.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)

    base = os.path.join(REPO, "media", "talang-pitch")
    with open(base + ".srt", "w", encoding="utf-8", newline="\n") as f:
        for i, s in enumerate(subs, 1):
            f.write(f"{i}\n{ts(s['start'], ',')} --> {ts(s['end'], ',')}\n" + "\n".join(s["rows"]) + "\n\n")
    with open(base + ".vtt", "w", encoding="utf-8", newline="\n") as f:
        f.write("WEBVTT\n\n")
        for i, s in enumerate(subs, 1):
            f.write(f"{i}\n{ts(s['start'], '.')} --> {ts(s['end'], '.')}\n" + "\n".join(s["rows"]) + "\n\n")

    cs = cards()

    def picture(s):
        if s["kind"] == "slide":
            return f"Slide {s['slide']} (deck/shots/{s['slide']}.png)"
        if "segs" in s:
            return f"media/{FOOTAGE[s['kind']]}, " + ", ".join(f"{a}-{b} s" for a, b in s["segs"])
        if s["kind"] == "card":
            return f"Card: {cs[s['card']]['kicker']} ({cs[s['card']]['src']})"
        return "Card: links"
    md = ["# Talang pitch narration", "",
          f"Narration for `media/talang-pitch.mp4`. Synthetic voice: Microsoft `{VOICE}` via edge-tts, rate {RATE}.",
          "Generated by `video/vo/say.py`, which is the source of truth; edit the script there and re-run.",
          f"Running time {int(t // 60)}:{t % 60:04.1f}. Subtitles: `media/talang-pitch.srt` / `.vtt`.", ""]
    for sc, meta in zip(SCENES, scenes):
        md.append(f"## {ts(meta['start'], ',')[3:8]} {sc['id']}")
        md.append(f"*{picture(sc)}*")
        md.append("")
        md += [l for l in sc["lines"]]
        md.append("")
    open(os.path.join(REPO, "docs", "pitch-narration.md"), "w", encoding="utf-8", newline="\n").write("\n".join(md))

    print(f"{len(clips)} clips, {len(subs)} subtitle events, total {t:.1f}s")
    for s in scenes:
        rate = f"  footage x{footage(s) / s['dur']:.2f}" if "segs" in s else ""
        print(f"  {s['id']:<15} {s['start']:6.1f}s  {s['dur']:5.1f}s{rate}")


asyncio.run(main())
