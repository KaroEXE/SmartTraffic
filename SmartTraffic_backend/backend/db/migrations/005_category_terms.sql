-- Words people type for a kind of place, in English, Arabic and Sorani Kurdish. A search for one of
-- them (or a close misspelling) also returns the nearest places of that category, whatever their
-- names are. The list is a starting point: add rows (term_norm = redoz_normalize(term)) as users
-- show what they type. Kurdish terms should be checked by a Kurdish speaker.
INSERT INTO category_terms (term_norm, category)
SELECT redoz_normalize(t.term), t.category
FROM (VALUES
  ('fuel', 'fuel'), ('gas station', 'fuel'), ('petrol', 'fuel'), ('petrol station', 'fuel'), ('بنزين', 'fuel'), ('محطة وقود', 'fuel'), ('محطة بنزين', 'fuel'), ('وقود', 'fuel'), ('بەنزینخانە', 'fuel'), ('بەنزین', 'fuel'),
  ('charging station', 'charging_station'), ('ev charging', 'charging_station'), ('charger', 'charging_station'), ('شاحن', 'charging_station'), ('محطة شحن', 'charging_station'),
  ('parking', 'parking'), ('car park', 'parking'), ('موقف', 'parking'), ('موقف سيارات', 'parking'), ('كراج', 'parking'), ('باركينغ', 'parking'), ('پارکینگ', 'parking'), ('گەراج', 'parking'),
  ('hospital', 'hospital'), ('hospitals', 'hospital'), ('مستشفى', 'hospital'), ('مستشفيات', 'hospital'), ('نەخۆشخانە', 'hospital'),
  ('pharmacy', 'pharmacy'), ('drugstore', 'pharmacy'), ('صيدلية', 'pharmacy'), ('دەرمانخانە', 'pharmacy'),
  ('police', 'police'), ('police station', 'police'), ('شرطة', 'police'), ('مركز شرطة', 'police'), ('پۆلیس', 'police'),
  ('restaurant', 'restaurant'), ('restaurants', 'restaurant'), ('food', 'restaurant'), ('مطعم', 'restaurant'), ('مطاعم', 'restaurant'), ('چێشتخانە', 'restaurant'), ('ڕێستۆرانت', 'restaurant'),
  ('cafe', 'cafe'), ('coffee', 'cafe'), ('coffee shop', 'cafe'), ('كافيه', 'cafe'), ('مقهى', 'cafe'), ('قهوة', 'cafe'), ('قاوەخانە', 'cafe'), ('کافێ', 'cafe'),
  ('atm', 'atm'), ('cash machine', 'atm'), ('صراف', 'atm'), ('صراف آلي', 'atm'),
  ('bank', 'bank'), ('بنك', 'bank'), ('مصرف', 'bank'), ('بانک', 'bank'),
  ('car repair', 'car_repair'), ('garage', 'car_repair'), ('mechanic', 'car_repair'), ('ورشة', 'car_repair'), ('تصليح سيارات', 'car_repair'),
  ('hotel', 'hotel'), ('hotels', 'hotel'), ('فندق', 'hotel'), ('فنادق', 'hotel'), ('هۆتێل', 'hotel'), ('میوانخانە', 'hotel'),
  ('school', 'school'), ('schools', 'school'), ('مدرسة', 'school'), ('مدارس', 'school'), ('قوتابخانە', 'school'), ('خوێندنگە', 'school'),
  ('university', 'university'), ('college', 'university'), ('جامعة', 'university'), ('كلية', 'university'), ('زانکۆ', 'university'), ('کۆلێژ', 'university'),
  ('mosque', 'mosque'), ('masjid', 'mosque'), ('مسجد', 'mosque'), ('جامع', 'mosque'), ('مزگەوت', 'mosque'),
  ('mall', 'shopping_mall'), ('shopping mall', 'shopping_mall'), ('مول', 'shopping_mall'), ('مجمع تجاري', 'shopping_mall'), ('مۆڵ', 'shopping_mall'),
  ('market', 'market'), ('supermarket', 'market'), ('bazaar', 'market'), ('سوق', 'market'), ('سوبرماركت', 'market'), ('بازاڕ', 'market'), ('سوپەرمارکێت', 'market'),
  ('park', 'park'), ('garden', 'park'), ('حديقة', 'park'), ('متنزه', 'park'), ('پارک', 'park'), ('باخچە', 'park'),
  ('clinic', 'clinic'), ('doctor', 'clinic'), ('عيادة', 'clinic'), ('طبيب', 'clinic'), ('کلینیک', 'clinic'), ('دکتۆر', 'clinic'),
  ('municipality', 'government'), ('government', 'government'), ('بلدية', 'government'), ('شارەوانی', 'government'),
  ('bakery', 'bakery'), ('مخبز', 'bakery'), ('نانەوایی', 'bakery')
) AS t(term, category)
ON CONFLICT DO NOTHING;
