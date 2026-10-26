import { Canvas, Storyboard } from "tempo-sdk/canvas";
import {
  FalhaDeConexao as FalhaDeConexao2,
  Tentando as Tentando2,
  FalhaDeAutorizacao as FalhaDeAutorizacao2,
  Mobile as Mobile2,
} from "./estados";

export default function InicioTentarDeNovoCanvas() {
  return (
    <Canvas name="Início Tentar de novo" backgroundColor="#232323">
      <Storyboard
        id="FalhaDeConexao"
        name="Falha de conexão — com Tentar de novo"
        component={FalhaDeConexao2}
        layout={{ x: 0, y: 0, width: 760, height: 140, intrinsicSizing: "root-element" }}
      />
      <Storyboard
        id="Tentando"
        name="Tentando de novo (busy)"
        component={Tentando2}
        layout={{ x: 810, y: 0, width: 760, height: 140, intrinsicSizing: "root-element" }}
      />
      <Storyboard
        id="FalhaDeAutorizacao"
        name="Falha de autorização — sem botão"
        component={FalhaDeAutorizacao2}
        layout={{ x: 1620, y: 0, width: 760, height: 140, intrinsicSizing: "root-element" }}
      />
      <Storyboard
        id="Mobile"
        name="Falha de conexão — 375px"
        component={Mobile2}
        layout={{ x: 2430, y: 0, width: 375, height: 220, intrinsicSizing: "root-element" }}
      />
    </Canvas>
  );
}
