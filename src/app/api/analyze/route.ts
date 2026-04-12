import {
  AnalyzeFeedbackError,
  analyzeFeedbackWithAi,
  type AnalyzeFeedbackImageInput,
} from "@/lib/ai/analyze-feedback";

export const runtime = "nodejs";

type AnalyzeBody = {
  note?: string;
  images: AnalyzeFeedbackImageInput[];
};

export async function POST(req: Request) {
  const body = (await req.json()) as AnalyzeBody;
  try {
    const result = await analyzeFeedbackWithAi({
      note: body?.note,
      images: body?.images ?? [],
    });
    return Response.json(result);
  } catch (e: any) {
    if (e instanceof AnalyzeFeedbackError) {
      return Response.json(
        {
          error: e.message,
          ...(e.details ?? {}),
        },
        { status: e.status }
      );
    }
    return Response.json(
      {
        error: e?.message ?? "分析失败",
      },
      { status: 500 }
    );
  }
}

