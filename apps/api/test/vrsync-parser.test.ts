import type { PropertyType } from '@imob/contracts';
import { describe, expect, it } from 'vitest';
import { propertyTypeKeys, resolvePropertyType } from '../src/modules/imports/property-types.js';
import {
  FeedFormatError,
  parseDecimalBR,
  parseMoneyCents,
  parseVrSyncFeed,
} from '../src/modules/imports/vrsync-parser.js';

/**
 * Feed no formato da documentacao oficial (developers.grupozap.com): namespace,
 * CDATA, atributos de moeda, periodo e unidade, <Zone> preenchido.
 */
const OFICIAL = `<?xml version="1.0" encoding="UTF-8"?>
<ListingDataFeed xmlns="http://www.vivareal.com/schemas/1.0/VRSync"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.vivareal.com/schemas/1.0/VRSync http://xml.vivareal.com/vrsync.xsd">
  <Header>
    <Provider>Sistema de Gestao</Provider>
    <Email>dev@alfa.test</Email>
    <ContactName>Alfa Imoveis</ContactName>
    <PublishDate>2026-09-14T10:00:00</PublishDate>
    <Telephone>43 3333-0000</Telephone>
  </Header>
  <Listings>
    <Listing>
      <ListingID>ALFA-0001</ListingID>
      <Title><![CDATA[Apartamento na Gleba Palhano com vista para o lago]]></Title>
      <TransactionType>Sale/Rent</TransactionType>
      <PublicationType>STANDARD</PublicationType>
      <DetailViewUrl>https://www.alfa.test/imovel/0001</DetailViewUrl>
      <Media>
        <Item medium="image" caption="Sala">http://fotos.alfa.test/0001/sala.jpg</Item>
        <Item medium="video">https://www.youtube.com/watch?v=alfa123</Item>
        <Item medium="image" caption="Fachada Alfa Imoveis" primary="true">https://fotos.alfa.test/0001/fachada.jpg</Item>
        <Item medium="image">http://fotos.alfa.test/0001/sala.jpg</Item>
        <Item medium="image">javascript:alert(1)</Item>
      </Media>
      <Details>
        <UsageType>Residential</UsageType>
        <PropertyType>Residential / Apartment</PropertyType>
        <Description><![CDATA[Falar com Renata, 43 99999-0000.]]></Description>
        <ListPrice currency="BRL">860000</ListPrice>
        <RentalPrice currency="BRL" period="Monthly">4500</RentalPrice>
        <PropertyAdministrationFee currency="BRL">950</PropertyAdministrationFee>
        <Iptu currency="BRL" period="Monthly">310</Iptu>
        <LivingArea unit="square metres">92</LivingArea>
        <LotArea unit="square metres">92</LotArea>
        <Bedrooms>3</Bedrooms>
        <Bathrooms>2</Bathrooms>
        <Suites>1</Suites>
        <Garage type="Parking Space">2</Garage>
      </Details>
      <Location displayAddress="Neighborhood">
        <Country abbreviation="BR">Brasil</Country>
        <State abbreviation="PR">Paraná</State>
        <City>Londrina</City>
        <Zone>Zona Sul</Zone>
        <Neighborhood>Gleba Palhano</Neighborhood>
        <Address>Rua Ulrico Zuinglio</Address>
        <StreetNumber>300</StreetNumber>
        <Complement>Apto 1201</Complement>
        <PostalCode>86050460</PostalCode>
        <Latitude>-23.3280</Latitude>
        <Longitude>-51.1850</Longitude>
      </Location>
      <ContactInfo>
        <Name>Alfa Imoveis</Name>
        <Email>contato@alfa.test</Email>
      </ContactInfo>
    </Listing>
  </Listings>
</ListingDataFeed>`;

describe('parser VrSync', () => {
  describe('formato oficial', () => {
    const feed = parseVrSyncFeed(OFICIAL);
    const listing = feed.listings[0]!;
    const data = listing.data;

    it('le o anuncio', () => {
      expect(feed.rejected).toEqual([]);
      expect(feed.listings).toHaveLength(1);
      expect(listing.externalId).toBe('ALFA-0001');
      expect(data.title).toBe('Apartamento na Gleba Palhano com vista para o lago');
      expect(data.propertyTypeRaw).toBe('Residential / Apartment');
    });

    it('Sale/Rent mantem os dois valores, sem perda', () => {
      expect(data.purpose).toBe('sale_rent');
      expect(data.salePriceCents).toBe(86_000_000);
      expect(data.rentPriceCents).toBe(450_000);
    });

    it('normaliza condominio mensal e IPTU mensal para anual', () => {
      expect(data.condoFeeCents).toBe(95_000);
      expect(data.iptuCents).toBe(310 * 12 * 100);
    });

    it('le areas e contagens', () => {
      expect(data.areaBuilt).toBe(92);
      expect(data.areaTotal).toBe(92);
      expect([data.bedrooms, data.bathrooms, data.suites, data.parkingSpots]).toEqual([3, 2, 1, 2]);
    });

    it('le a localizacao, com CEP formatado', () => {
      expect(data.location).toEqual({
        countryAbbr: 'BR',
        stateAbbr: 'PR',
        city: 'Londrina',
        neighborhood: 'Gleba Palhano',
        street: 'Rua Ulrico Zuinglio',
        streetNumber: '300',
        complement: 'Apto 1201',
        postalCode: '86050-460',
        latitude: -23.328,
        longitude: -51.185,
      });
    });

    it('<Zone> fica so no payload bruto, nunca nos dados normalizados', () => {
      expect(JSON.stringify(data)).not.toContain('Zona Sul');
      expect(Object.keys(data.location)).not.toContain('zone');
      expect(JSON.stringify(listing.raw)).toContain('Zona Sul');
    });

    it('fotos vem do <Media>: principal primeiro, sem repetir, sem video nem URL invalida', () => {
      expect(data.media).toEqual([
        { url: 'https://fotos.alfa.test/0001/fachada.jpg', caption: 'Fachada Alfa Imoveis', primary: true },
        { url: 'http://fotos.alfa.test/0001/sala.jpg', caption: 'Sala', primary: false },
      ]);
      expect(listing.warnings.some((w) => w.includes('vídeo'))).toBe(true);
      expect(listing.warnings.some((w) => w.includes('URL inválida'))).toBe(true);
    });
  });

  describe('variacoes entre sistemas de gestao', () => {
    it('aceita feed sem namespace, com tags em outra caixa e campos soltos no Listing', () => {
      const xml = `<?xml version="1.0"?>
        <listingdatafeed><listings><listing>
          <listingid>B-77</listingid>
          <transactiontype>For Rent</transactiontype>
          <propertytype>Apartamento</propertytype>
          <rentalprice currency="BRL">R$ 2.350,00</rentalprice>
          <PROPERTYADMINISTRATIONFEE>480,50</PROPERTYADMINISTRATIONFEE>
          <YearlyTax>1.200</YearlyTax>
          <LivingArea>68,5</LivingArea>
          <Bedrooms>2</Bedrooms>
          <location><state>pr</state><city>Londrina</city><neighborhood>Jd. Higienópolis</neighborhood></location>
          <media><item>https://img.beta.test/77.jpg</item></media>
        </listing></listings></listingdatafeed>`;

      const { listings, rejected } = parseVrSyncFeed(xml);
      expect(rejected).toEqual([]);
      const data = listings[0]!.data;

      expect(data.purpose).toBe('rent');
      expect(data.rentPriceCents).toBe(235_000);
      expect(data.salePriceCents).toBeNull();
      expect(data.condoFeeCents).toBe(48_050);
      expect(data.iptuCents).toBe(120_000);
      expect(data.areaBuilt).toBe(68.5);
      expect(data.bedrooms).toBe(2);
      expect(data.location.stateAbbr).toBe('PR');
      expect(data.location.neighborhood).toBe('Jd. Higienópolis');
      // <Item> sem medium: tratado como imagem.
      expect(data.media).toEqual([{ url: 'https://img.beta.test/77.jpg', caption: null, primary: false }]);
    });

    it('converte aluguel anual para mensal e recusa temporada, avisando', () => {
      const xml = (period: string) => `<ListingDataFeed><Listings><Listing>
          <ListingID>R-1</ListingID><TransactionType>For Rent</TransactionType>
          <Details><RentalPrice period="${period}">54000</RentalPrice></Details>
        </Listing></Listings></ListingDataFeed>`;

      const anual = parseVrSyncFeed(xml('Yearly')).listings[0]!;
      expect(anual.data.rentPriceCents).toBe(450_000);
      expect(anual.warnings.join(' ')).toMatch(/anual convertido/);

      const diaria = parseVrSyncFeed(xml('Daily')).listings[0]!;
      expect(diaria.data.rentPriceCents).toBeNull();
      expect(diaria.warnings.join(' ')).toMatch(/temporada/);
    });

    it('descarta o valor que contradiz a finalidade, avisando', () => {
      const xml = `<ListingDataFeed><Listings><Listing>
          <ListingID>S-1</ListingID><TransactionType>For Sale</TransactionType>
          <Details><ListPrice>500000</ListPrice><RentalPrice>2500</RentalPrice></Details>
        </Listing></Listings></ListingDataFeed>`;
      const listing = parseVrSyncFeed(xml).listings[0]!;
      expect(listing.data.purpose).toBe('sale');
      expect(listing.data.salePriceCents).toBe(50_000_000);
      expect(listing.data.rentPriceCents).toBeNull();
      expect(listing.warnings.join(' ')).toMatch(/RentalPrice ignorado/);
    });

    it('deduz a finalidade dos valores quando TransactionType falta', () => {
      const xml = `<ListingDataFeed><Listings><Listing>
          <ListingID>D-1</ListingID>
          <Details><ListPrice>300000</ListPrice><RentalPrice>1500</RentalPrice></Details>
        </Listing></Listings></ListingDataFeed>`;
      const listing = parseVrSyncFeed(xml).listings[0]!;
      expect(listing.data.purpose).toBe('sale_rent');
      expect(listing.warnings.join(' ')).toMatch(/deduzida/);
    });

    it('limita suites ao numero de quartos', () => {
      const xml = `<ListingDataFeed><Listings><Listing>
          <ListingID>Q-1</ListingID><TransactionType>For Sale</TransactionType>
          <Details><Bedrooms>2</Bedrooms><Suites>4</Suites></Details>
        </Listing></Listings></ListingDataFeed>`;
      const listing = parseVrSyncFeed(xml).listings[0]!;
      expect(listing.data.suites).toBe(2);
    });
  });

  describe('recusas', () => {
    it('rejeita anuncio sem ListingID e ListingID repetido, sem derrubar os demais', () => {
      const xml = `<ListingDataFeed><Listings>
          <Listing><TransactionType>For Sale</TransactionType></Listing>
          <Listing><ListingID>X-1</ListingID><TransactionType>For Sale</TransactionType></Listing>
          <Listing><ListingID>X-1</ListingID><TransactionType>For Rent</TransactionType></Listing>
        </Listings></ListingDataFeed>`;
      const { listings, rejected } = parseVrSyncFeed(xml);
      expect(listings.map((l) => l.externalId)).toEqual(['X-1']);
      expect(rejected).toHaveLength(2);
      expect(rejected[0]!.errors.join(' ')).toMatch(/ListingID ausente/);
      expect(rejected[1]!.errors.join(' ')).toMatch(/repetido/);
    });

    it('recusa o XML ZAP legado com mensagem que orienta a exportar em VrSync', () => {
      const xml = '<Carga><Imoveis><Imovel><CodigoImovel>1</CodigoImovel></Imovel></Imoveis></Carga>';
      expect(() => parseVrSyncFeed(xml)).toThrow(FeedFormatError);
      expect(() => parseVrSyncFeed(xml)).toThrow(/VrSync/);
    });

    it('recusa DOCTYPE e ENTITY (expansao de entidade / XXE)', () => {
      const bomba = `<?xml version="1.0"?>
        <!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
        <ListingDataFeed><Listings><Listing><ListingID>&lol2;</ListingID></Listing></Listings></ListingDataFeed>`;
      expect(() => parseVrSyncFeed(bomba)).toThrow(/DOCTYPE/);
    });

    it('recusa XML malformado e documento sem <Listings>', () => {
      expect(() => parseVrSyncFeed('<ListingDataFeed><Listings>')).toThrow(FeedFormatError);
      expect(() => parseVrSyncFeed('<rss><channel/></rss>')).toThrow(/Listings/);
    });
  });

  describe('numeros', () => {
    it.each([
      ['860000', 860000],
      ['860000.00', 860000],
      ['860.000', 860000],
      ['860.000,00', 860000],
      ['860,000.00', 860000],
      ['R$ 4.500', 4500],
      ['92,5', 92.5],
      ['80.5', 80.5],
      ['1,234,567', 1234567],
      ['', null],
      ['sob consulta', null],
      ['-100', null],
    ])('parseDecimalBR(%j) = %j', (input, expected) => {
      expect(parseDecimalBR(input)).toBe(expected);
    });

    it('valor zero vira "sob consulta"', () => {
      expect(parseMoneyCents('0')).toBeNull();
      expect(parseMoneyCents('0,00')).toBeNull();
    });
  });
});

describe('traducao de PropertyType', () => {
  const mappings = new Map<string, PropertyType>([
    ['apartment', 'apartamento'],
    ['land-lot', 'terreno'],
    ['condo', 'casa_condominio'],
    ['apartamento', 'apartamento'],
  ]);

  it('gera chaves da mais especifica para a mais generica', () => {
    expect(propertyTypeKeys('Residential / Apartment')).toEqual(['residential-apartment', 'apartment']);
    expect(propertyTypeKeys('Commercial / Land Lot')).toEqual(['commercial-land-lot', 'land-lot']);
    expect(propertyTypeKeys(null)).toEqual([]);
  });

  it('casa pelo ultimo segmento, com ou sem prefixo de uso', () => {
    expect(resolvePropertyType('Residential / Apartment', mappings)).toEqual({
      type: 'apartamento',
      matchedKey: 'apartment',
    });
    expect(resolvePropertyType('Commercial / Land Lot', mappings).type).toBe('terreno');
    expect(resolvePropertyType('Residencial - Apartamento', mappings).type).toBe('apartamento');
    expect(resolvePropertyType('Residential / Condo', mappings).type).toBe('casa_condominio');
  });

  it('tipo desconhecido cai em "outro" sem chave casada', () => {
    expect(resolvePropertyType('Commercial / Hotel', mappings)).toEqual({ type: 'outro', matchedKey: null });
  });
});
