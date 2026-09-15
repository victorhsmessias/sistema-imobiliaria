/**
 * Marca provisoria: dois imoveis lado a lado, a parceria.
 *
 * Neutra de proposito. A marca anterior desenhava as zonas da cidade e
 * prometia uma busca por zona que o produto nao tem. A identidade definitiva
 * e item futuro, fora do escopo tecnico.
 *
 * Usa currentColor: herda a cor do texto ao lado, na barra escura e no fundo
 * claro.
 */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 28) / 32} viewBox="0 0 32 28" aria-hidden="true">
      <polygon points="1,13 10,5 19,13 19,27 1,27" fill="currentColor" opacity="0.55" />
      <polygon points="13,13 22,5 31,13 31,27 13,27" fill="currentColor" />
    </svg>
  );
}
