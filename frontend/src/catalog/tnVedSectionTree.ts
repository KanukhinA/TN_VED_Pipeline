/**
 * Иерархия ТН ВЭД ЕАЭС: разделы I–XXI → двузначные группы 01–97.
 * Границы разделов по Общей номенклатуре (HS) ЕАЭС.
 */

import type { TnVedGroupRef } from "./tnVedGroupsData";
import { TN_VED_GROUPS } from "./tnVedGroupsData";

export type TnVedSectionDef = {
  /** Римский номер раздела */
  roman: string;
  /** Краткое название раздела */
  title: string;
  groupFrom: number;
  groupTo: number;
};

/** 21 раздел ТН ВЭД и диапазоны двузначных групп (включительно). */
export const TN_VED_SECTION_DEFS: TnVedSectionDef[] = [
  { roman: "I", title: "Живые животные; продукты животного происхождения", groupFrom: 1, groupTo: 5 },
  { roman: "II", title: "Продукты растительного происхождения", groupFrom: 6, groupTo: 14 },
  { roman: "III", title: "Животные или растительные жиры и масла", groupFrom: 15, groupTo: 15 },
  { roman: "IV", title: "Готовые пищевые продукты; алкоголь и уксус; табак", groupFrom: 16, groupTo: 24 },
  { roman: "V", title: "Минеральные продукты", groupFrom: 25, groupTo: 27 },
  { roman: "VI", title: "Продукция химической и смежных отраслей", groupFrom: 28, groupTo: 38 },
  { roman: "VII", title: "Пластмассы и резина; каучук", groupFrom: 39, groupTo: 40 },
  { roman: "VIII", title: "Сырые шкуры, кожа, меха", groupFrom: 41, groupTo: 43 },
  { roman: "IX", title: "Древесина и изделия из неё; пробка; солома", groupFrom: 44, groupTo: 46 },
  { roman: "X", title: "Масса древесная; бумага и картон", groupFrom: 47, groupTo: 49 },
  { roman: "XI", title: "Текстиль и текстильные изделия", groupFrom: 50, groupTo: 63 },
  { roman: "XII", title: "Обувь, головные уборы, зонты и др.", groupFrom: 64, groupTo: 67 },
  { roman: "XIII", title: "Изделия из камня, гипса, цемента, керамики, стекла", groupFrom: 68, groupTo: 70 },
  { roman: "XIV", title: "Жемчуг, драгоценные камни и металлы", groupFrom: 71, groupTo: 71 },
  { roman: "XV", title: "Недрагоценные металлы и изделия из них", groupFrom: 72, groupTo: 83 },
  { roman: "XVI", title: "Машины и оборудование; электротехника", groupFrom: 84, groupTo: 85 },
  { roman: "XVII", title: "Средства наземного транспорта, летательные аппараты, суда", groupFrom: 86, groupTo: 89 },
  { roman: "XVIII", title: "Оптика, фото, медицина, часы, музыка", groupFrom: 90, groupTo: 92 },
  { roman: "XIX", title: "Оружие и боеприпасы; прочие готовые изделия", groupFrom: 93, groupTo: 95 },
  { roman: "XX", title: "Разные промышленные товары", groupFrom: 96, groupTo: 96 },
  { roman: "XXI", title: "Произведения искусства, коллекции и антиквариат", groupFrom: 97, groupTo: 97 },
];

export function groupsInSection(def: TnVedSectionDef): TnVedGroupRef[] {
  return TN_VED_GROUPS.filter((g) => {
    const n = parseInt(g.code, 10);
    return n >= def.groupFrom && n <= def.groupTo;
  });
}
