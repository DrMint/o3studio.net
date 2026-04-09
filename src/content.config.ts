import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { defineCollection, reference } from "astro:content";

const booksCollection = defineCollection({
  loader: glob({ base: "src/content/books", pattern: "**/*.md" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      subtitle: z.string(),
      cover: image(),
      render: image(),
      darkColor: z.string(),
      lightColor: z.string(),
    }),
});

const seriesCollection = defineCollection({
  loader: glob({ base: "src/content/series", pattern: "**/*.md" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      image: image(),
      books: z.array(reference("books")),
      short: z.string(),
    }),
});

export const collections = {
  books: booksCollection,
  series: seriesCollection,
};
