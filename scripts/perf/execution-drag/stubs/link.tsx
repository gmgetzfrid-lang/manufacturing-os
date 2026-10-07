// PERF-5 harness: stands in for next/link in the bundle.
import React from "react";

type Props = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string | { pathname?: string } };
export default function Link({ href, children, ...rest }: Props) {
  return <a href={typeof href === "string" ? href : href.pathname ?? "#"} {...rest}>{children}</a>;
}
