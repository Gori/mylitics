"use client";

import React, { useRef } from 'react';

interface CircularTextProps {
  text: string;
  spinDuration?: number;
  className?: string;
  radius?: number;
}

export const CircularText: React.FC<CircularTextProps> = ({
  text,
  spinDuration = 20,
  className = '',
  radius = 150,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);

  const padding = 80;
  const size = radius * 2 + padding;

  return (
    <>
      <style>
        {`
          @keyframes spin {
            from {
              transform: rotate(0deg);
            }
            to {
              transform: rotate(360deg);
            }
          }
        `}
      </style>
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`-${radius + padding / 2} -${radius + padding / 2} ${size} ${size}`}
        className={className}
        style={{
          animation: `spin ${spinDuration}s linear infinite`,
          transformOrigin: 'center',
          zIndex: 20,
          willChange: 'transform',
          contain: 'layout style paint',
        } as React.CSSProperties}
      >
        <defs>
          <path
            id="circlePath"
            d={`M 0, -${radius} a ${radius},${radius} 0 1,1 0,${radius * 2} a ${radius},${radius} 0 1,1 0,-${radius * 2}`}
            fill="none"
          />
        </defs>
        <text
          fontSize="40"
          fontWeight="700"
          fill="black"
          letterSpacing="1"
          fontFamily="var(--font-haffer), sans-serif"
        >
          <textPath href="#circlePath" startOffset="0%" textAnchor="start">
            {text}
          </textPath>
        </text>
      </svg>
    </>
  );
};

