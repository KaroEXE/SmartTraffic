-- redoz_normalize(text): the one place where a name or a query is folded for matching.
-- Search stores redoz_normalize(name) in search_names.name_norm and applies the same function to the
-- query, so spelling variants meet: Arabic / Sorani Kurdish / Persian letters (ك ک, ي ی ى ێ ئ, ه ە ة,
-- أ إ آ), vowel marks and tatweel, Arabic-Indic digits, Latin accents, punctuation and case.
-- IMMUTABLE so it can be used in indexes; it needs no extension (unaccent is STABLE, so it cannot).
CREATE OR REPLACE FUNCTION redoz_normalize(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          translate(lower(input), 'أإآٱةەھہىیېێئکپچژگڤڕڵۆؤ٠۰١۱٢۲٣۳٤۴٥۵٦۶٧۷٨۸٩۹àáâãäåāăąçćčđďèéêëēĕėęěğìíîïĩīĭįıłñňòóôõöøōřşšśţťùúûüūŭůűýÿžźżə', 'ااااههههيييييكبجزكفرلوو00112233445566778899aaaaaaaaacccddeeeeeeeeegiiiiiiiiilnnooooooorsssttuuuuuuuuyyzzza'),
          '[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF''’ʼʻʿʾ`´]', '', 'g'),
        '[\s_\-.,;:!?"()\[\]{}/\\|&+*#@%^=<>~·،؛؟«»]+', ' ', 'g'),
      '\s+', ' ', 'g'))
$$;
