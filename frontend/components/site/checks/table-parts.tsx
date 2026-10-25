"use client";

import type { ComponentProps } from "react";

/**
 * A table row that keeps its row role explicitly. The catalogue table lays its rows out as grids (and as stacked
 * cards on narrow screens), and some browsers drop table semantics when `display` is overridden. This is a client
 * component only so it can be handed to `<Reveal as={Tr}>` from a Server Component; it holds no state.
 */
export function Tr(props: ComponentProps<"tr">) {
  return <tr role="row" {...props} />;
}
