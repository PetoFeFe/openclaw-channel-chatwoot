import { describe, expect, it } from "vitest";
import { extractImageUrls } from "../src/media.js";

describe("extractImageUrls", () => {
  it("lifts a Markdown image out of the caption", () => {
    const input =
      "Segue a tabela em imagem também:\n\n![preços](https://chatwoot.test/rails/active_storage/x.png)\n\nBora fechar?";
    const { text, images } = extractImageUrls(input);
    expect(images).toEqual(["https://chatwoot.test/rails/active_storage/x.png"]);
    expect(text).toBe("Segue a tabela em imagem também:\n\nBora fechar?");
  });

  it("leaves bare links untouched", () => {
    const input = "Veja https://example.com/precos para mais detalhes";
    const { text, images } = extractImageUrls(input);
    expect(images).toEqual([]);
    expect(text).toBe(input);
  });

  it("dedupes repeated images", () => {
    const url = "https://x.test/a.png";
    const { images } = extractImageUrls(`![a](${url}) e de novo ![a](${url})`);
    expect(images).toEqual([url]);
  });

  it("handles text with no images", () => {
    const { text, images } = extractImageUrls("Olá!");
    expect(text).toBe("Olá!");
    expect(images).toEqual([]);
  });

  it("returns an empty caption when the reply is only an image", () => {
    const { text, images } = extractImageUrls("![tabela](https://x.test/a.png)");
    expect(text).toBe("");
    expect(images).toEqual(["https://x.test/a.png"]);
  });
});
