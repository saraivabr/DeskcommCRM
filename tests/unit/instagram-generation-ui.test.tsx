import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CreatePost } from "@/app/app/instagram/_create";
import { Review } from "@/app/app/instagram/_review";

const { api, push } = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }));
vi.mock("@/app/app/instagram/_publish", () => ({ PublishPost: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/app/app/instagram/_shared", () => ({
  studioApi: api,
  StudioShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Intro: () => null,
  Notice: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Loading: () => <div>Carregando</div>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
const company = {
  name: "Café",
  description: "Cafeteria",
  descriptionSource: null,
  logoPath: null,
  logoUrl: null,
  accent: null,
};

it("anima enquanto aguarda a API e encerra com erro, permitindo tentar novamente", async () => {
  let reject!: (error: Error) => void;
  api.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  render(
    <CreatePost
      company={company}
      initialNiche="Cafeteria"
      initialBrief="Uma imagem de café artesanal"
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Gerar minha imagem" }));
  expect(screen.getByRole("status")).toHaveAccessibleName("Criando sua imagem…");
  expect(screen.getByRole("button", { name: "Criando sua imagem…" })).toBeDisabled();
  await act(async () => reject(new Error("Falha na geração")));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText("Falha na geração")).toBeVisible();
  expect(screen.getByRole("button", { name: "Gerar minha imagem" })).toBeEnabled();
});

it("abre a revisão quando a geração retorna", async () => {
  api.mockResolvedValue({ id: "post-1" });
  render(
    <CreatePost
      company={company}
      initialNiche="Cafeteria"
      initialBrief="Uma imagem de café artesanal"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Gerar minha imagem" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/app/instagram/posts/post-1"));
  expect(screen.queryByRole("status")).toBeNull();
});

it.each(["ready", "failed"])(
  "encerra animação na revisão quando o polling retorna %s",
  async (status) => {
    vi.useFakeTimers();
    const item = {
      id: "post-1",
      input: { kind: "post", format: "feed", brief: "Café artesanal", niche: "Cafeteria" },
      caption: "",
      status: "generating",
      image_url: null,
    };
    api.mockResolvedValueOnce(item).mockResolvedValueOnce({
      ...item,
      status,
      image_url: status === "ready" ? "https://example.com/cafe.png" : null,
      error: status === "failed" ? "Falha na geração" : null,
    });
    render(<Review id="post-1" />);
    await act(async () => {});
    expect(screen.getByRole("status")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      status === "ready" ? screen.getByRole("img") : screen.getByText("Falha na geração"),
    ).toBeVisible();
  },
);
