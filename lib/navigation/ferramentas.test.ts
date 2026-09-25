import { describe, expect, it } from "vitest";
import { searchable, toolSections, workspaceGroups } from "./registry";

describe("navegação do espaço de trabalho", () => {
  it("organiza o uso diário mantendo os destinos existentes", () => {
    const groups = workspaceGroups(searchable(false, "admin"));
    expect(groups.map((group) => group.label)).toEqual(["Trabalhar", "Criar", "Organizar"]);
    expect(groups[0]?.items.map((item) => item.href)).toEqual([
      "/app/inbox",
      "/app/prospecting",
      "/app/kanban",
      "/app/agenda",
    ]);
    expect(groups[1]?.items[0]?.workspace?.label).toBe("Conteúdo");
  });
  it("o catálogo contém exatamente cada destino visível, sem incluir a própria navegação", () => {
    const destinations = searchable(false, "admin");
    const tools = toolSections(destinations).flatMap((section) =>
      section.items.map((item) => item.href),
    );
    expect([...tools].sort()).toEqual(
      destinations
        .map((item) => item.href)
        .filter((href) => href !== "/app" && href !== "/app/ferramentas")
        .sort(),
    );
    expect(new Set(tools).size).toBe(tools.length);
  });
  it("busca sem acento e filtra pela categoria sem perder as permissões", () => {
    const destinations = searchable(false, "agent");
    expect(toolSections(destinations, "credenciais")).toEqual([]);
    expect(toolSections(destinations, "rapidas")[0]?.items[0]?.href).toBe("/app/templates");
    expect(
      toolSections(destinations, "", "marketing").every((section) => section.id === "marketing"),
    ).toBe(true);
    expect(
      workspaceGroups(destinations)
        .flatMap((group) => group.items)
        .some((item) => item.href === "/app/ai/agents"),
    ).toBe(false);
  });
  it("respeita os destinos escolhidos e mantém a porta do catálogo acessível", () => {
    const destinations = searchable(false, "agent", {
      preset: "completa",
      destinos: ["/app/inbox"],
    });
    expect(destinations.some((item) => item.href === "/app/ferramentas")).toBe(true);
    expect(
      toolSections(destinations)
        .flatMap((group) => group.items)
        .some((item) => item.href === "/app/instagram"),
    ).toBe(false);
  });
});
