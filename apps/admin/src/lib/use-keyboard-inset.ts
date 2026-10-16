"use client";

import { useEffect, useState } from "react";

/**
 * How many pixels of the LAYOUT viewport the on-screen keyboard covers (phase 16 M1). On iOS
 * Safari the keyboard does not resize the layout viewport, so a box fixed / sticky to its bottom
 * (the chat's reply box) would sit behind the keyboard. Below `MIN_INSET` it is a browser bar or
 * a rounding difference, not a keyboard: 0.
 */
export const MIN_INSET = 80;

export function keyboardInset(
  layoutHeight: number,
  visual: { height: number; offsetTop: number },
): number {
  const inset = layoutHeight - visual.height - visual.offsetTop;
  return inset > MIN_INSET ? Math.round(inset) : 0;
}

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const update = () => setInset(keyboardInset(window.innerHeight, visual));
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    update();
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
