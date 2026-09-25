import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { Sidebar } from "@/components/shell/Sidebar";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import type { Branding } from "@/lib/branding";
import { MarcaDaInstalacaoProvider } from "@/lib/branding/contexto";

/** A identidade do produto e a do espaço são exibidas separadamente.
 * Branding da organização continua visível, inclusive com uma organização só.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox" }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
// Os dois buscam estado do servidor e não têm nada a ver com o nome da marca.
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));

/**
 * A marca da INSTALAÇÃO, como o SERVIDOR a entrega.
 *
 * ⚠️ Isto era um `vi.mock("@/lib/branding")` até a correção do hydration
 * mismatch. Não é mais: a barra deixou de chamar `branding()` — que lia
 * `window.__PUBLIC_ENV__` no navegador e `process.env` no SSR, fontes que
 * divergiram quando o layout raiz passou a injetar a marca do BANCO — e passou a
 * receber a marca por PROP, via `MarcaDaInstalacaoProvider`. Montar o provedor
 * aqui é o jeito honesto de simular "o operador gravou um logo na tela de
 * marca": deste lado da fronteira é exatamente o que o layout raiz faz.
 *
 * `logoUrl: null` no padrão porque com logo a barra mostra a imagem NO LUGAR do
 * texto — os três primeiros casos, que medem nome, não mediriam nada.
 */
let marcaDaInstalacao: Branding = {
  name: "Sistema do Revendedor",
  logoUrl: null,
  initial: "S",
};

/** A barra como o layout raiz a monta: dentro do provedor da marca. */
function renderSidebar(props: { collapsed: boolean }) {
  return render(
    <MarcaDaInstalacaoProvider marca={marcaDaInstalacao}>
      <Sidebar collapsed={props.collapsed} />
    </MarcaDaInstalacaoProvider>,
  );
}

const usuario = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@exemplo.test",
  is_platform_admin: false,
  organizations: [],
} as unknown as AuthUser;

const org = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  name: "Loja da Ana",
  role: "admin",
} as ActiveOrg;

let contexto: { user: AuthUser; activeOrg: ActiveOrg | null } = { user: usuario, activeOrg: org };
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => contexto,
}));

describe("o nome da marca na barra lateral", () => {
  it("sem marca da organização, mostra o nome da instalação", () => {
    // Não-regressão: a organização que nunca abriu a tela de marca precisa ver
    // exatamente o que via antes. É também a guarda de vacuidade do caso
    // seguinte — se a barra nunca mostrasse nome nenhum, os dois passariam.
    contexto = { user: usuario, activeOrg: org };
    renderSidebar({ collapsed: false });
    expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
  });

  it("com marca da organização, identifica o espaço sem substituir o produto", () => {
    contexto = { user: usuario, activeOrg: { ...org, marca: { nome: "Loja da Ana" } } };
    renderSidebar({ collapsed: false });
    expect(screen.getByText("Loja da Ana")).toBeTruthy();
    expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
    expect(screen.getByText("Espaço de trabalho")).toBeTruthy();
  });

  it("recolhida, a inicial acompanha o nome que a barra mostra", () => {
    // As duas identidades continuam distintas quando o menu está recolhido.
    contexto = { user: usuario, activeOrg: { ...org, marca: { nome: "Loja da Ana" } } };
    renderSidebar({ collapsed: true });
    expect(screen.getByText("L")).toBeTruthy();
    expect(screen.getByText("S")).toBeTruthy();
  });
});

/**
 * O CONSUMIDOR do logo — a outra metade, e a que estava faltando.
 *
 * POR QUE ESTE BLOCO EXISTE: medido antes desta onda, `platform_branding.logo_url`
 * era gravável e ilegível. O único render de logo do produto é esta barra, e ela
 * lia `window.__PUBLIC_ENV__.APP_LOGO_URL`, que vinha do `.env` cru — o operador
 * salvava e nada mudava. Estes casos medem a barra DESENHANDO a imagem, não a
 * presença do símbolo `logoUrl` no arquivo.
 *
 * O que eles NÃO provam, declarado: que a marca entregue ao provedor venha mesmo
 * do banco. Aquilo é a costura do layout raiz (`marcaResolvida()` alimentando o
 * `<MarcaDaInstalacaoProvider/>`), guardada em `tests/unit/branding.test.ts`, e a
 * prova de ponta a ponta é pela tela. Nem provam que os dois lados da fronteira
 * concordam — isso é `tests/unit/marca-sem-divergencia-de-hidratacao.test.tsx`.
 */
describe("o logo na barra lateral", () => {
  const LOGO_DA_INSTALACAO = "https://cdn.exemplo.test/revendedor.png";
  const LOGO_DA_ORG = "https://cdn.exemplo.test/loja-da-ana.png";

  afterEach(() => {
    marcaDaInstalacao = { name: "Sistema do Revendedor", logoUrl: null, initial: "S" };
  });

  const imagem = () => screen.getByRole("img");

  it("com logo da instalação, a barra desenha a imagem no lugar do nome", () => {
    marcaDaInstalacao = { ...marcaDaInstalacao, logoUrl: LOGO_DA_INSTALACAO };
    contexto = { user: usuario, activeOrg: org };
    renderSidebar({ collapsed: false });

    expect(imagem().getAttribute("src")).toBe(LOGO_DA_INSTALACAO);
    // A ausência importa: uma barra que mostrasse imagem E nome passaria só na
    // asserção de cima, e o cabeçalho tem 56px de altura para um dos dois.
    expect(screen.queryByText("Sistema do Revendedor")).toBeNull();
  });

  it("o logo da organização identifica o espaço e preserva o da instalação", () => {
    marcaDaInstalacao = { ...marcaDaInstalacao, logoUrl: LOGO_DA_INSTALACAO };
    contexto = {
      user: usuario,
      activeOrg: { ...org, marca: { nome: "Loja da Ana", logoUrl: LOGO_DA_ORG } },
    };
    renderSidebar({ collapsed: false });

    expect(screen.getByRole("img", { name: "Loja da Ana" })).toHaveAttribute("src", LOGO_DA_ORG);
    expect(screen.getByRole("img", { name: "Sistema do Revendedor" })).toHaveAttribute(
      "src",
      LOGO_DA_INSTALACAO,
    );
  });

  it("logo VAZIO na organização cai para o da instalação, não apaga a marca", () => {
    // O caso que separa `||` de `??`. Vazio é AUSÊNCIA — a mesma regra que
    // `resolveBranding` e `primeiroDefinido` aplicam nas camadas de baixo. Com
    // `??`, `""` venceria a camada de cima e a barra cairia no TEXTO, apagando o
    // logo do revendedor por causa de um campo em branco.
    marcaDaInstalacao = { ...marcaDaInstalacao, logoUrl: LOGO_DA_INSTALACAO };
    contexto = { user: usuario, activeOrg: { ...org, marca: { logoUrl: "" } } };
    renderSidebar({ collapsed: false });

    expect(imagem().getAttribute("src")).toBe(LOGO_DA_INSTALACAO);
  });

  it("sem logo nenhum, continua sendo o nome — não uma imagem quebrada", () => {
    // Guarda de vacuidade dos três de cima: se a barra desenhasse `<img>` sempre,
    // com `src` vazio, todos passariam pelo `getByRole("img")` e o produto
    // mostraria o ícone de imagem quebrada em toda instalação de fábrica.
    contexto = { user: usuario, activeOrg: org };
    renderSidebar({ collapsed: false });

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
  });
});
