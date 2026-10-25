"use client";

import { useQuery } from "@tanstack/react-query";
import { getBatch } from "./batches";
import { listFindings } from "./findings";

export function useFindings() {
  return useQuery({
    queryKey: ["findings"],
    queryFn: ({ signal }) => listFindings({ signal }),
  });
}

export function useBatch(id: string) {
  return useQuery({
    queryKey: ["batch", id],
    queryFn: ({ signal }) => getBatch(id, { signal }),
  });
}
