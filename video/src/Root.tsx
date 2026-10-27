import React from 'react';
import { Composition } from 'remotion';
import { Film, FilmProps } from './Film';
import { FPS, TOTAL } from './timeline';

export const Root: React.FC = () => (
  <>
    <Composition id="UsFilm" component={Film} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080}
      defaultProps={{ market: 'us', bgm: true } as FilmProps} />
    <Composition id="TwFilm" component={Film} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080}
      defaultProps={{ market: 'tw', bgm: true } as FilmProps} />
  </>
);
