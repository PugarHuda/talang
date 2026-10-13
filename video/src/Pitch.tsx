import React, {useCallback, useEffect, useState} from 'react';
import {
  AbsoluteFill,
  Audio,
  continueRender,
  delayRender,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
} from 'remotion';
// Written by vo/say.py from the measured voice clips. Never edit by hand.
import timeline from './timeline.json';

export const FPS = timeline.fps;
export const PITCH_DURATION = Math.ceil(timeline.total * FPS);

// Brand tokens from web/landing.css.
const DARK = '#0f0b1c';
const INK = '#120d24';
const INK_2 = '#3b3552';
const MUTED = '#6c6683';
const VIOLET = '#6a2cf0';
const LILAC = '#ddd0ff';
const CORAL = '#ffb3a7';
const SANS = "'Geist', ui-sans-serif, system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, Consolas, monospace";
const LAVENDER = `radial-gradient(60% 50% at 85% 10%, rgba(173,140,255,.35), transparent 70%),
  radial-gradient(50% 40% at 0% 60%, rgba(255,190,230,.25), transparent 70%),
  radial-gradient(70% 50% at 50% 110%, rgba(150,120,255,.3), transparent 70%), #e9e5f6`;

const FONT_CSS = `
@font-face{font-family:'Geist';font-weight:100 900;font-display:block;src:url(${staticFile('fonts/geist.woff2')}) format('woff2');}
@font-face{font-family:'Geist Mono';font-weight:400;font-display:block;src:url(${staticFile('fonts/geist-mono.woff2')}) format('woff2');}`;

const useFonts = () => {
  const [handle] = useState(() => delayRender('fonts'));
  const ready = useCallback(() => continueRender(handle), [handle]);
  useEffect(() => {
    Promise.all([document.fonts.load(`600 40px 'Geist'`), document.fonts.load(`400 20px 'Geist Mono'`)])
      .then(() => document.fonts.ready)
      .then(ready)
      .catch(ready);
  }, [ready]);
};

// The picture sits in a 1600x900 stage at the top; the band underneath belongs
// to the subtitles, so they never cover the UI being described.
const STAGE = {x: 160, y: 14, w: 1600, h: 900};
const XFADE = 8; // frames of cross-dissolve between scenes

type Scene = (typeof timeline.scenes)[number];

const fade = (frame: number, a: number, b: number) =>
  interpolate(frame, [a, b], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

const SlideScene: React.FC<{slide: string; frames: number}> = ({slide, frames}) => {
  const frame = useCurrentFrame();
  const s = interpolate(frame, [0, frames], [1, 1.025]);
  return (
    <Img
      src={staticFile(`shots/${slide}.png`)}
      style={{width: STAGE.w, height: STAGE.h, transform: `scale(${s})`}}
    />
  );
};

// Each recording's picture area; grofty-wallet.mp4 carries its own captions in a band
// below row 900, which the stage crops off (its 1440 px width is centred, lavender either side).
const FRAME: Record<string, {w: number; h: number; x: number}> = {
  'grofty-wallet.mp4': {w: 1440, h: 980, x: 80},
};

const FootageScene: React.FC<{src: string; segs: number[][]; frames: number}> = ({src, segs, frames}) => {
  // One rate across the scene's ranges, so the recording fills exactly the narrated time.
  const total = segs.reduce((n, [a, b]) => n + b - a, 0);
  const rate = total / (frames / FPS);
  const f = FRAME[src] ?? {w: STAGE.w, h: STAGE.h, x: 0};
  let at = 0;
  return (
    <>
      {segs.map(([a, b], i) => {
        const from = at;
        // the last range also runs under the next scene's fade-in
        const len = i === segs.length - 1 ? frames + XFADE - from : Math.round(((b - a) / rate) * FPS);
        at += len;
        return (
          <Sequence key={a} from={from} durationInFrames={len} layout="none">
            <OffthreadVideo src={staticFile(src)} muted trimBefore={Math.round(a * FPS)} playbackRate={rate}
              style={{position: 'absolute', left: f.x, top: 0, width: f.w, height: f.h}} />
          </Sequence>
        );
      })}
    </>
  );
};

type Card = {
  kicker: string; title: string; hl: string; head: string[];
  rows: {l: string; r: string; bad?: boolean}[];
  pill: string; foot: string; src: string;
};

// Evidence and roadmap cards; every row comes from docs/evidence via vo/say.py.
const CardScene: React.FC<{card: Card}> = ({card}) => {
  const frame = useCurrentFrame();
  const big = card.rows.length <= 5;
  return (
    <AbsoluteFill style={{background: LAVENDER, padding: '56px 90px', fontFamily: SANS, color: INK}}>
      <div style={{font: `500 18px/1 ${MONO}`, letterSpacing: '.12em', color: MUTED, textTransform: 'uppercase'}}>
        {card.kicker}
      </div>
      <div style={{font: `400 60px/1.08 ${SANS}`, letterSpacing: '-.03em', marginTop: 22}}>
        {card.title}<span style={{color: VIOLET}}>{card.hl}</span>
      </div>
      <div
        style={{
          marginTop: 30,
          background: 'rgba(255,255,255,.62)',
          border: '1px solid rgba(255,255,255,.9)',
          borderRadius: 24,
          padding: '12px 28px',
          boxShadow: '0 30px 80px -30px rgba(70,40,160,.35)',
        }}
      >
        <div style={{display: 'flex', font: `500 16px/1 ${MONO}`, letterSpacing: '.1em', color: MUTED, padding: '14px 0'}}>
          <div style={{flex: 1}}>{card.head[0]}</div>
          <div style={{width: 300}}>{card.head[1]}</div>
        </div>
        {card.rows.map((r, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              borderTop: '1px solid rgba(18,13,36,.08)',
              padding: big ? '16px 0' : '11px 0',
              opacity: fade(frame, 10 + i * 9, 22 + i * 9),
            }}
          >
            <div style={{flex: 1, font: `500 ${big ? 28 : 24}px/1.25 ${SANS}`, color: INK, paddingRight: 24}}>{r.l}</div>
            <div style={{width: 300, font: `400 ${big ? 23 : 21}px/1 ${MONO}`, color: r.bad ? '#b4232f' : INK_2}}>{r.r}</div>
          </div>
        ))}
      </div>
      <div style={{display: 'flex', alignItems: 'center', gap: 14, marginTop: 24, font: `400 21px/1.4 ${SANS}`, color: INK_2}}>
        <span style={{background: card.pill === 'NOT YET' ? CORAL : LILAC, color: INK, font: `600 17px/1 ${MONO}`, padding: '7px 12px', borderRadius: 8}}>
          {card.pill}
        </span>
        {card.foot}
        <span style={{color: MUTED, marginLeft: 'auto', font: `400 17px/1 ${MONO}`}}>{card.src}</span>
      </div>
    </AbsoluteFill>
  );
};

const CloseCard: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{background: LAVENDER, padding: '0 120px', justifyContent: 'center', fontFamily: SANS, color: INK}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 16, font: `600 34px/1 ${SANS}`}}>
        <svg viewBox="0 0 32 32" width="46" height="46">
          <path d="M16 3 28 10v12L16 29 4 22V10z" fill="#120d24" />
          <path d="M16 3 28 10 16 17 4 10z" fill="#3a2b66" />
          <path d="M16 17v12L4 22V10z" fill="#1d1538" />
          <circle cx="16" cy="17" r="3.2" fill="#8b5cff" />
        </svg>
        talang
      </div>
      <div style={{font: `400 112px/1 ${SANS}`, letterSpacing: '-.045em', marginTop: 40}}>
        Repo quotes, <span style={{color: VIOLET}}>behind glass</span>
      </div>
      <div style={{display: 'flex', gap: 18, marginTop: 56}}>
        <span style={{opacity: fade(frame, 6, 18), background: INK, color: '#fff', font: `400 34px/1 ${MONO}`, padding: '16px 22px', borderRadius: 12}}>
          talang-desk.vercel.app
        </span>
        <span style={{opacity: fade(frame, 18, 30), background: LILAC, color: INK, font: `400 34px/1 ${MONO}`, padding: '16px 22px', borderRadius: 12}}>
          github.com/PugarHuda/talang
        </span>
      </div>
      <div style={{marginTop: 44, font: `400 24px/1.4 ${SANS}`, color: MUTED}}>
        HackCanton Season 3 · Pugar Huda Mantoro · narration is a synthetic voice
      </div>
    </AbsoluteFill>
  );
};

const SceneView: React.FC<{scene: Scene; frames: number}> = ({scene, frames}) => {
  const frame = useCurrentFrame();
  let body: React.ReactNode = null;
  const sc = scene as {slide?: string; src?: string; segs?: number[][]; card?: string};
  if (sc.slide) body = <SlideScene slide={sc.slide} frames={frames} />;
  else if (sc.src && sc.segs) body = <FootageScene src={sc.src} segs={sc.segs} frames={frames} />;
  else if (sc.card) body = <CardScene card={(timeline.cards as Record<string, Card>)[sc.card]} />;
  else body = <CloseCard />;
  return <AbsoluteFill style={{opacity: fade(frame, 0, XFADE), overflow: 'hidden'}}>{body}</AbsoluteFill>;
};

const Subtitles: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const sub = timeline.subs.find((s) => t >= s.start && t < s.end);
  if (!sub) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: STAGE.y + STAGE.h + 10,
        bottom: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'rgba(0,0,0,.62)',
          borderRadius: 12,
          padding: '10px 30px 12px',
          font: `500 40px/1.3 ${SANS}`,
          color: '#fff',
          textAlign: 'center',
          letterSpacing: '-.005em',
        }}
      >
        {sub.rows.map((r, i) => (
          <div key={i}>{r}</div>
        ))}
      </div>
    </div>
  );
};

export const Pitch: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(70% 60% at 80% 0%, rgba(106,44,240,.28), transparent 70%), radial-gradient(60% 50% at 0% 100%, rgba(139,92,255,.18), transparent 70%), ${DARK}`,
      }}
    >
      <style>{FONT_CSS}</style>
      <div
        style={{
          position: 'absolute',
          left: STAGE.x,
          top: STAGE.y,
          width: STAGE.w,
          height: STAGE.h,
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 26px 70px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08)',
          background: '#e9e5f6',
        }}
      >
        {timeline.scenes.map((sc, i) => {
          const from = Math.round(sc.start * FPS);
          const frames = Math.round(sc.dur * FPS);
          // each scene runs a few frames long, under the next one's fade-in
          const last = i === timeline.scenes.length - 1;
          return (
            <Sequence key={sc.id} from={from} durationInFrames={last ? PITCH_DURATION - from : frames + XFADE} layout="none">
              <SceneView scene={sc} frames={frames} />
            </Sequence>
          );
        })}
      </div>
      {timeline.clips.map((c) => (
        <Sequence key={c.file + c.start} from={Math.round(c.start * FPS)} layout="none">
          <Audio src={staticFile(c.file)} />
        </Sequence>
      ))}
      <Subtitles />
    </AbsoluteFill>
  );
};
