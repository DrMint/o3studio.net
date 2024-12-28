import { z, defineCollection, reference } from "astro:content";

const booksCollection = defineCollection({
  type: "content",
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
  type: "content",
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
