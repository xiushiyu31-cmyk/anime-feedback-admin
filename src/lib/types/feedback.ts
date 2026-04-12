export type FeedbackStatus = "pending" | "processing" | "done";
export type MainView = "submit" | "pool" | "ranking" | "weekly" | "import" | "review";

export type FeedbackItem = {
  id: string;
  createdAt: string;
  userNickname: string | null;
  operatorName: string | null;
  category: string | null;
  essenceKey: string | null;
  weight: number | null;
  title: string;
  detail: string;
  status: FeedbackStatus;
  needsReview: boolean;
  screenshotPublicUrl: string | null;
  aiSummary: string | null;
};

export type FormState = {
  note: string;
  userNickname: string;
  operatorName: string;
};

export const emptyForm: FormState = {
  note: "",
  userNickname: "",
  operatorName: "",
};

export const statusLabels: Record<FeedbackStatus, string> = {
  pending: "待处理",
  processing: "处理中",
  done: "已完成",
};

export type UiImage = {
  id: string;
  file: File;
  previewUrl: string;
};
