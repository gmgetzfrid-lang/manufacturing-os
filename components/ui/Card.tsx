// Card — the one elevated-panel recipe. Token surface + hairline border +
// soft layered shadow (from the global elevation system), so every panel
// reads identically on both themes. `interactive` adds the hover-lift used
// for clickable cards/tiles; `as` lets it render a button or link.

import React from "react";

const PAD = { none: "", sm: "p-3", md: "p-4", lg: "p-5" } as const;

export function Card<T extends React.ElementType = "div">({
  as,
  interactive = false,
  padding = "md",
  className = "",
  children,
  ...rest
}: {
  as?: T;
  interactive?: boolean;
  padding?: keyof typeof PAD;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ComponentPropsWithoutRef<T>, "as" | "className" | "children">) {
  const Comp = (as || "div") as React.ElementType;
  return (
    <Comp
      className={`card-surface rounded-2xl ${PAD[padding]} ${
        interactive ? "hover-lift cursor-pointer text-left w-full" : ""
      } ${className}`}
      {...rest}
    >
      {children}
    </Comp>
  );
}

export default Card;
