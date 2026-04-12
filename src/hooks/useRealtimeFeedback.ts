"use client";

import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase/client";

type Options = {
  onInsert?: () => void;
  onUpdate?: () => void;
  onDelete?: () => void;
};

export function useRealtimeFeedback({ onInsert, onUpdate, onDelete }: Options) {
  const cbRef = useRef({ onInsert, onUpdate, onDelete });
  cbRef.current = { onInsert, onUpdate, onDelete };

  useEffect(() => {
    const channel = supabase
      .channel("feedback_realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "feedback_submissions" },
        () => cbRef.current.onInsert?.()
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "feedback_submissions" },
        () => cbRef.current.onUpdate?.()
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "feedback_submissions" },
        () => cbRef.current.onDelete?.()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
}
