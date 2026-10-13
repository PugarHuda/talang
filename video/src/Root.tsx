import React from 'react';
import {Composition} from 'remotion';
import {FPS, Pitch, PITCH_DURATION} from './Pitch';

export const Root: React.FC = () => (
  <Composition id="TalangPitch" component={Pitch} durationInFrames={PITCH_DURATION} fps={FPS} width={1920} height={1080} />
);
