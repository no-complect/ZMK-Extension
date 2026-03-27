import { useEffect, useRef, useState } from "react";

export interface ContainerSize {
  width: number;
  height: number;
}

/**
 * Observes the size of a DOM element using ResizeObserver.
 * Attach the returned ref to the element you want to measure.
 *
 * @example
 * const { ref, width, height } = useContainerSize();
 * return <div ref={ref} className="@container">...</div>;
 */
export function useContainerSize<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<ContainerSize>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver(([entry]) => {
      const { inlineSize: width, blockSize: height } =
        entry.contentBoxSize?.[0] ?? { inlineSize: 0, blockSize: 0 };
      setSize({ width, height });
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, ...size };
}

/**
 * Calculates the CSS scale factor needed to fit a keyboard of `naturalWidth`
 * into a container of `availableWidth`, with optional min/max clamps.
 *
 * @example
 * const scale = useKeyboardScale({ naturalWidth: 900, availableWidth: width });
 * // Returns e.g. 0.6 when panel is 540px wide
 */
export function useKeyboardScale({
  naturalWidth,
  availableWidth,
  min = 0.3,
  max = 1.0,
  padding = 16,
}: {
  naturalWidth: number;
  availableWidth: number;
  min?: number;
  max?: number;
  /** Horizontal padding to leave on each side (px) */
  padding?: number;
}): number {
  if (availableWidth === 0 || naturalWidth === 0) return 1;
  const usable = Math.max(0, availableWidth - padding * 2);
  return Math.min(max, Math.max(min, usable / naturalWidth));
}
