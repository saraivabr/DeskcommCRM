import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AiUsageBreakdown } from "./AiUsageBreakdown";
import { FreeBetaCard } from "./FreeBetaCard";
import { PlanComparison } from "./PlanComparison";
it("distingue pendência de consumo confirmado e não apresenta custo USD como saldo", () => {
  render(
    <AiUsageBreakdown
      idioma="pt-BR"
      usage={[
        {
          kind: "image",
          operations: 3,
          settledOperations: 2,
          pendingOperations: 1,
          commercialUsedBrlCents: 125,
          reservedBrlCents: 350,
          knownProviderCostUsdCents: 9999,
        },
      ]}
    />,
  );
  expect(screen.getByText(/1 operações aguardando/)).toBeInTheDocument();
  expect(screen.getByText(/1,25.*utilizados/)).toBeInTheDocument();
  expect(screen.getByText(/3,50.*reservados/)).toBeInTheDocument();
  expect(screen.queryByText(/99,99/)).toBeNull();
});
it("não oferece checkout nem inventa franquia para Free aguardando ativação", () => {
  render(
    <FreeBetaCard
      now={new Date("2026-09-25").getTime()}
      idioma="pt-BR"
      account={{
        free_enabled: false,
        free_seats: null,
        free_channels: null,
        free_agents: null,
        free_ai_credit_cents: null,
        free_period_start: null,
        free_period_end: null,
      }}
    />,
  );
  expect(screen.getByText(/aguarda liberação/)).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getAllByText("A definir")).toHaveLength(3);
});
it("inclui IA em todos os planos preservando preços e deixando o beta explícito", () => {
  render(<PlanComparison idioma="pt-BR" />);
  expect(screen.getByRole("heading", { name: "IA em todos os planos" })).toBeInTheDocument();
  expect(screen.getByText(/Free beta: acesso por convite/)).toBeInTheDocument();
  for (const value of [197, 397, 797])
    expect(screen.getByText(new RegExp(`R\\$\\s*${value}`))).toBeInTheDocument();
});
it.each([
  ["2000-01-01", "2000-02-01", "expirou"],
  ["2100-01-01", "2100-02-01", "aguarda o início"],
])("não oferece geração fora do período %s", (start, end, message) => {
  render(
    <FreeBetaCard
      now={new Date("2026-09-25").getTime()}
      idioma="pt-BR"
      account={{
        free_enabled: true,
        free_seats: 1,
        free_channels: 1,
        free_agents: 1,
        free_ai_credit_cents: 100,
        free_period_start: start,
        free_period_end: end,
      }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(message);
  expect(screen.queryByRole("link", { name: "Criar minha primeira postagem" })).toBeNull();
});
it("indica liberação pendente mesmo habilitado se ainda não há franquia e período", () => {
  render(
    <FreeBetaCard
      now={new Date("2026-09-25").getTime()}
      idioma="pt-BR"
      account={{
        free_enabled: true,
        free_seats: null,
        free_channels: null,
        free_agents: null,
        free_ai_credit_cents: null,
        free_period_start: null,
        free_period_end: null,
      }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("aguarda liberação");
  expect(screen.queryByRole("link")).toBeNull();
});
