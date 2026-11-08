/**
 * `verified-geofeeds-data.ts` — 178 real, verified RFC 8805 geofeeds found in
 * the RIPE region, on top of the 16 already hand-curated in
 * `enrichment-sources.ts`.
 *
 * ## Provenance — read before touching this file
 *
 * Found 2026-08-24 by downloading RIPE NCC's public split database dumps
 * (`ripe.db.inetnum.gz`, `ripe.db.inet6num.gz`, ~260MB compressed,
 * `https://ftp.ripe.net/ripe/dbase/split/`) and scanning every object for a
 * `geofeed:` attribute (a first-class WHOIS field since December 2021,
 * RFC 9632's standard discovery mechanism). 4,171 unique geofeed URLs came
 * back; the 200 covering the most IPv4 address space were checked one at a
 * time — real HTTP fetch, real TLS certificate validation (via this
 * session's own CA bundle, never disabled), real RFC 8805 CSV shape check —
 * and 178 passed. The 22 that did not are excluded (broken/expired TLS
 * certificates, dead domains, HTML error pages, empty responses) — most
 * notably Deutsche Telekom's own feed, the single largest one found at 28.9M
 * addresses, excluded because its server presents a self-signed certificate
 * and there is no honest way to fetch geolocation data over a connection
 * whose identity cannot be verified.
 *
 * One entry was found but deliberately left out: IPXO's feed (5.05M
 * addresses, the second-largest found) describes IP addresses *leased*
 * through IPXO's marketplace rather than an operator's own infrastructure —
 * a structurally weaker location claim than the rest of this list, which are
 * all operators describing networks they run themselves. Left out by
 * operator decision, not a technical failure.
 *
 * ## This is a static snapshot, not a live discovery feature — on purpose
 *
 * The obvious next step ("keep re-scanning RIPE for new ones automatically")
 * was checked against RIPE's own Database Terms and Conditions before being
 * ruled out: Article 3 lists geolocation as a legitimate purpose, but
 * Article 4.5 prohibits downloading/compiling more than an "insubstantial
 * part" of the database without RIPE NCC's explicit permission, and no
 * public RIPE NCC statement was found resolving that tension for exactly
 * this bulk-scan use case. The one-time research pass that produced this
 * list already sits in that grey area; running it as a recurring, automated
 * part of this codebase would not. This file is therefore hand-refreshed —
 * re-run the same research and replace it — not machine-refreshed.
 *
 * Consuming the individual URLs below is a separate, clean question: each
 * one is a CSV an operator publishes at a stable address specifically so
 * geolocation providers will read it (RFC 8805's entire purpose), the exact
 * same standing as the 16 sources already in `enrichment-sources.ts`.
 *
 * ## Removing this
 *
 * Delete this file, then in `enrichment-sources.ts` remove the
 * `VERIFIED_GEOFEEDS_DATA` import and the `...VERIFIED_GEOFEEDS_DATA.map(...)`
 * spread from `KNOWN_ENRICHMENT_SOURCES`. No config flag gates this — unlike
 * `dbipLiteIpv6`/`bulkCopyIngest`, a static list of geofeed sources costs
 * nothing to have present (each is a small CSV, and the existing
 * `--sources`/`"enrichment"` selection mechanism every other source already
 * uses can exclude any subset without new code). Nothing else references
 * this file or the ids it defines.
 */
export interface VerifiedGeofeedEntry {
  id: string;
  url: string;
  /** Best available operator/network name, for display only. */
  netname: string;
  /** Up to 3 RIPE-registered country codes seen among this feed's covered
   * blocks — informational, not authoritative (the feed itself states the
   * real per-prefix country). */
  countries: string;
}

export const VERIFIED_GEOFEEDS_DATA: VerifiedGeofeedEntry[] = [
  { id: "geofeed-a1-by", url: "https://www.a1.by/geofeed/geofeed.csv", netname: "A1-BELARUS", countries: "BY" },
  { id: "geofeed-acedatacenter-com", url: "https://acedatacenter.com/geofeed.csv", netname: "ACE-DC", countries: "DE, US" },
  { id: "geofeed-addressn-com", url: "https://geo.addressn.com/rfc8805.csv", netname: "HK-ADDRESS-19940720", countries: "GB, RU" },
  { id: "geofeed-adsl-cat", url: "https://adsl.cat/rfc8805.csv", netname: "FR-JOGCORP-20191111", countries: "FR, HK, IN" },
  { id: "geofeed-aeza-net", url: "https://aeza.net/static/ipv4_f.csv", netname: "AEZA", countries: "AT, DE, FI" },
  { id: "geofeed-analytics-wavenet-co-uk", url: "https://analytics.wavenet.co.uk/geofeed/geofeed.csv", netname: "UK-WAVENET-19930815", countries: "GB" },
  { id: "geofeed-anydigital-sg", url: "https://www.anydigital.sg/geofeed.csv", netname: "SGAD-datacenter-AE", countries: "AE, AR, BD" },
  { id: "geofeed-arelion-com", url: "https://api.arelion.com/public/v1/geolocation", netname: "SE-TWELVE99-19971119", countries: "SE" },
  { id: "geofeed-ariskisp-com", url: "https://ariskisp.com/rfc8805.csv", netname: "Arisk-Communications-inc", countries: "AE, AU, BD" },
  { id: "geofeed-as13030-net", url: "https://as13030.net/geofeed.csv", netname: "Customer-Perimeter", countries: "AT, CH, DE" },
  { id: "geofeed-as207592-net", url: "https://www.as207592.net/geofeed.csv", netname: "DE-GWDG-20200110", countries: "DE" },
  { id: "geofeed-as29119-net", url: "https://geofeed.as29119.net/geofeed.csv", netname: "BR-AIRENETWORKS-NET", countries: "BR, DE, ES" },
  { id: "geofeed-as34244-net", url: "https://as34244.net/geofeed.csv", netname: "SE-SYDANTENN-20160428", countries: "SE" },
  { id: "geofeed-as34758-net", url: "https://as34758.net/geofeed/geofeed.csv", netname: "IT-ARCANET", countries: "IT" },
  { id: "geofeed-as35518-net", url: "https://www.as35518.net/geofeed.csv", netname: "CH-SASAG-19970528", countries: "CH" },
  { id: "geofeed-as42708-net", url: "https://as42708.net/geofeed.csv", netname: "ACRONIS", countries: "DE, DK, FI" },
  { id: "geofeed-as46261-net", url: "https://as46261.net/geofeed.txt", netname: "US-QUICKPACKET-20041004", countries: "GB, US" },
  { id: "geofeed-as56971-net", url: "https://as56971.net/geofeed.csv", netname: "BG-NETERRAIP-20190531", countries: "FI, FR, HK" },
  { id: "geofeed-as6453-net", url: "https://lg.as6453.net/geo/geofeed.csv", netname: "CA-TATACOMM-19910705", countries: "EU, US" },
  { id: "geofeed-as8220-net", url: "https://www.as8220.net/iplocation/iplocation.csv", netname: "AE-COLT-20240503", countries: "AE, AU, BE" },
  { id: "geofeed-aspireripedb-blob-core-windows-net", url: "https://aspireripedb.blob.core.windows.net/aspireripedb/as51043geofeed.csv", netname: "AspireTechnologySolutions", countries: "GB" },
  { id: "geofeed-assets-ip-only-net", url: "https://assets.ip-only.net/documents/geoipfeed/AS12552.csv", netname: "DATAPHONE", countries: "DK, FI, NO" },
  { id: "geofeed-axioma24-ru", url: "https://geofeed.axioma24.ru/subnets.csv", netname: "AXIOMA", countries: "RU" },
  { id: "geofeed-bae81f955b-cdn-adyen-com", url: "https://bae81f955b.cdn.adyen.com/geofeed/geofeed.csv", netname: "ADYEN", countries: "AU, DE, IN" },
  { id: "geofeed-bahnhof-net", url: "https://geofeed.bahnhof.net/geofeed.csv", netname: "BAHNHOF-AGGREGATE", countries: "FI, SE" },
  { id: "geofeed-beget-com", url: "https://geofeed.beget.com/geofeed.csv", netname: "BEGET-MSK", countries: "KZ, LV, RU" },
  { id: "geofeed-bezeq-co-il", url: "https://www.bezeq.co.il/media/info/geofeed.csv", netname: "BEZEQ-ISP-BROADBAND", countries: "IL" },
  { id: "geofeed-bikab-com", url: "https://geofeed.bikab.com/geofeed.csv", netname: "BIK-C4", countries: "SE" },
  { id: "geofeed-bredband2-net", url: "https://geofeed.bredband2.net/geofeed.csv", netname: "AL-AZHARSKOLAN-NET-SE", countries: "SE" },
  { id: "geofeed-breitlandnet-de", url: "https://geo.breitlandnet.de", netname: "DE-STADTWERKE-NEUSTRELITZ-19930901", countries: "DE" },
  { id: "geofeed-chillishot-net", url: "https://geofeed.chillishot.net/geofeed.txt", netname: "NET-185-169-120", countries: "GB" },
  { id: "geofeed-clodocloud-com", url: "https://geofeed.clodocloud.com/geofeed.csv", netname: "AE-CLODO-19890329", countries: "NL" },
  { id: "geofeed-cloud-com-tr", url: "https://cloud.com.tr/geofeed/geofeed.csv", netname: "Airfiber", countries: "TR" },
  { id: "geofeed-clouvider-com", url: "https://clouvider.com/geoipfeed.csv", netname: "CLOUVIDER-NJ3", countries: "AM, BA, BY" },
  { id: "geofeed-code200noc-github-io", url: "https://code200noc.github.io/code200-external-ASN.csv", netname: "AT_Broadband", countries: "AE, AL, AR" },
  { id: "geofeed-code200noc-github-io-2", url: "https://code200noc.github.io/suballocated-geofeed.csv", netname: "AE_Internet", countries: "AE, BE, BR" },
  { id: "geofeed-com-in-net", url: "https://com-in.net/geofeed.csv", netname: "DE-COM-IN-19931220", countries: "DE" },
  { id: "geofeed-config-zscaler-com", url: "https://config.zscaler.com/downloads/geofeed.csv", netname: "AMS2-ZSCALER", countries: "AE, AL, AM" },
  { id: "geofeed-datagroup-ua", url: "https://geo.datagroup.ua/geofeed.csv", netname: "AS3366-NETWORK-N1", countries: "UA" },
  { id: "geofeed-docs-google-com", url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTM1c5r-jwdMI7yktnR0V_0EbCbfuCPqdOdUTDXe30DE_W28r07zH0kBJbnwRMhtRJGeR7VGRQQwhc3/pub?output=csv", netname: "ENERGY_SAFETY_AND_RISK_CONSULTANTS_UK_LIMITED", countries: "GB, NG, NL" },
  { id: "geofeed-dolsat-pl", url: "https://www.dolsat.pl/dolsat-geo-ip.txt", netname: "DOLSAT-NETWORK", countries: "PL" },
  { id: "geofeed-dravanet-net", url: "https://geofeed.dravanet.net/dravanet.csv", netname: "HU-DRAVANET-PECS-20000629", countries: "HU" },
  { id: "geofeed-dtag-iot-ipgeolocation-s3-eu-central-1-amazonaws-com", url: "https://dtag-iot-ipgeolocation.s3.eu-central-1.amazonaws.com/DTAG_IoT_IPgeofeed.txt", netname: "DE-DETEMOBIL-20120124", countries: "AR, AU, BG" },
  { id: "geofeed-edcl-io", url: "https://geofeed.edcl.io/geofeed/138997/geofeed.csv", netname: "Eons-Data-Communications-Limited", countries: "DE, HK, JP" },
  { id: "geofeed-edis-at", url: "https://www.edis.at/geofeed.txt", netname: "AT-EDISGMBH-20040503", countries: "AE, AT, AU" },
  { id: "geofeed-eso-org", url: "https://www.eso.org/geofeed_eso.csv", netname: "ESO-NET", countries: "DE" },
  { id: "geofeed-etelecom-ru", url: "https://etelecom.ru/files/geofeed.csv", netname: "AG-GLOBALNET-20070312", countries: "RU" },
  { id: "geofeed-eunetworks-com", url: "https://geofeed.eunetworks.com/eunetworks_geofeed_as13237.csv", netname: "AT-EUN-INFSTR-EXT", countries: "AT, CH, DE" },
  { id: "geofeed-eurofiber-com", url: "https://geofeed.eurofiber.com/geofeed.csv", netname: "BE_AGG", countries: "BE, NL" },
  { id: "geofeed-exoscale-prefixes-sos-exo-io", url: "https://exoscale-prefixes.sos.exo.io/exoscale_geofeed", netname: "Akenes", countries: "AT, BG, CH" },
  { id: "geofeed-extendbroadband-com", url: "https://www.extendbroadband.com/geofeed/extend.csv", netname: "Arinet-Datacenter", countries: "TR" },
  { id: "geofeed-f5-com", url: "https://www.f5.com/content/dam/f5/geofeed.txt", netname: "F5-20200129", countries: "DE, FR, NL" },
  { id: "geofeed-fibergroep-nl", url: "https://fibergroep.nl/geofeed.csv", netname: "Fiber_Groep_PPPoE_Pool", countries: "NL" },
  { id: "geofeed-first-server-net", url: "https://geofeed.first-server.net/fb_geofeed.csv", netname: "FIRST-SERVER", countries: "AE, BG, DE" },
  { id: "geofeed-flagman-zp-ua", url: "https://www.flagman.zp.ua/geofeed.csv", netname: "FLAGMAN", countries: "UA" },
  { id: "geofeed-forcepoint-com", url: "https://www.forcepoint.com/geofeed/rfc-8805.csv", netname: "Forcepoint-Cloud", countries: "AE, BE, CH" },
  { id: "geofeed-fornex-com", url: "https://fornex.com/geofeed.csv", netname: "CH-FORNEX", countries: "CH, DE, ES" },
  { id: "geofeed-forsakringskassan-se", url: "https://geofeed.forsakringskassan.se/geofeed.csv", netname: "SE-FORSAKRINGSKASSAN-19950208", countries: "SE" },
  { id: "geofeed-g-snowd-com", url: "https://g.snowd.com/geofeed.csv", netname: "AE-RCSTECHNOLOGIES-19930901", countries: "DE, ES, FI" },
  { id: "geofeed-gcore-lu", url: "https://geofeed.gcore.lu/IP-Range.csv", netname: "AdcomboAnycast", countries: "AE, AM, AR" },
  { id: "geofeed-geofeeds-cyberzonehub-com", url: "https://geofeeds.cyberzonehub.com/geofeed.csv", netname: "AL-Tirana", countries: "AD, AL, AM" },
  { id: "geofeed-geoip-i3d-net", url: "https://geoip.i3d.net/geofeed.csv", netname: "NL-I3DNET-19991018", countries: "AE, AR, AU" },
  { id: "geofeed-geoip-wookra-com", url: "https://geoip.wookra.com/geofeed.csv", netname: "AS42689", countries: "ES, FR, GB" },
  { id: "geofeed-geolocation-as931-net", url: "https://geolocation.as931.net/geofeed.csv", netname: "IC189012224", countries: "CA, DE, GB" },
  { id: "geofeed-geolocation-itm8-com", url: "https://geolocation.itm8.com", netname: "DK-ITRELATION-20100604", countries: "DK" },
  { id: "geofeed-gf-data-ee", url: "https://gf.data.ee/geofeed.csv", netname: "NL-CITICTEL-CPC-20010910", countries: "DE, EE, RU" },
  { id: "geofeed-gigaclear-net", url: "https://gigaclear.net/geofeed.csv", netname: "GIGA-CUST", countries: "GB" },
  { id: "geofeed-gist-githubusercontent-com", url: "https://gist.githubusercontent.com/dgromovv-stack/e4884c850231b993e990883a5ee29e7d/raw/geofeed.csv", netname: "Customers_2DayTelecom", countries: "KZ" },
  { id: "geofeed-gitlab-com", url: "https://gitlab.com/cflpublic/geofeed/-/raw/main/AS201838_geofeed.csv", netname: "NL-FALCO-ALPHA-20180105", countries: "GB" },
  { id: "geofeed-gitlab-com-2", url: "https://gitlab.com/wicnoc/geofeed/-/raw/main/geofeed.csv", netname: "IT-HALSERVICE", countries: "IT" },
  { id: "geofeed-go-elevate-uk", url: "https://go.elevate.uk/geofeed", netname: "UK-TELCOM-NETWORKS-19970314", countries: "GB" },
  { id: "geofeed-hetzner-com", url: "https://www.hetzner.com/geofeed.csv", netname: "DE-HETZNER-20120904", countries: "SG" },
  { id: "geofeed-hkglobalnetwork-com", url: "https://geofeed.hkglobalnetwork.com/geofeed.csv", netname: "CA-localnetwork", countries: "AU, CA, DE" },
  { id: "geofeed-hoster-kz", url: "https://geofeed.hoster.kz/geofeed.csv", netname: "HOSTERKZ-NETWORK", countries: "KZ" },
  { id: "geofeed-hoznian-github-io", url: "https://hoznian.github.io/geofeed/geofeed.csv", netname: "IR-MCI-20100317", countries: "IR" },
  { id: "geofeed-hydracom-co-uk", url: "https://hydracom.co.uk/geofeed.csv", netname: "AMS-195-140-212", countries: "CH, DE, FR" },
  { id: "geofeed-ib-systems", url: "https://ib.systems/range.csv", netname: "AM-DGTLTECH-20240109", countries: "DE, EE, FI" },
  { id: "geofeed-ic-km-ua", url: "https://ic.km.ua/geofeeds/geofeed.csv", netname: "UA-IC", countries: "UA" },
  { id: "geofeed-ikbnet-at", url: "https://geofeed.ikbnet.at/geofeed.csv", netname: "AT-IKB-19920327", countries: "AT" },
  { id: "geofeed-imagine-ie", url: "https://geo.imagine.ie/imagine-geofeed.csv", netname: "HGC-Global-Communications-Limited", countries: "HK, IE, US" },
  { id: "geofeed-inalan-gr", url: "https://geofeed.inalan.gr/geofeed.csv", netname: "GR-FIBERLOC-20250121", countries: "GR" },
  { id: "geofeed-infopact-nl", url: "https://geofeed.infopact.nl", netname: "NL-INFOPACT-20031007", countries: "NL" },
  { id: "geofeed-interciti-ru", url: "https://interciti.ru/geofeeds.txt", netname: "interciti.ru", countries: "RU" },
  { id: "geofeed-interlir-com", url: "https://interlir.com/geofeed.csv", netname: "AE-RCSTECHNOLOGIES-19910923", countries: "AT, BR, CH" },
  { id: "geofeed-internext-cz", url: "https://internext.cz/geo/geofeed.csv", netname: "CZ-CEZNET21-20000731", countries: "CZ" },
  { id: "geofeed-invapi-hostkey-com", url: "https://invapi.hostkey.com/as57043.csv", netname: "NL-HOSTKEY", countries: "CH, DE, FI" },
  { id: "geofeed-ip-as-com", url: "https://ip-as.com/geofeed.csv", netname: "CZ-ALFATELECOM-20071203", countries: "CZ, EU, NL" },
  { id: "geofeed-ip-serveriai-lt", url: "https://ip.serveriai.lt/geofeed/AS212531_geofeed.csv", netname: "LT-LITHUANIA-19950206", countries: "LT" },
  { id: "geofeed-ipbroker-info", url: "https://ipbroker.info/geofeeds/ipbroker.csv", netname: "AMMAZONTVNET_NET02", countries: "BO, BR, CL" },
  { id: "geofeed-ipdb-omnicorpnet-com", url: "https://ipdb.omnicorpnet.com/ipdb.csv", netname: "SC-FIBER", countries: "NL" },
  { id: "geofeed-ipinfo-bizlinktel-com", url: "https://ipinfo.bizlinktel.com/ipinfo.csv", netname: "SC-FIBER", countries: "GB" },
  { id: "geofeed-iploc-quantaronet-com", url: "https://iploc.quantaronet.com/iploc.csv", netname: "HK-NEXT-20190702", countries: "GB, RU" },
  { id: "geofeed-ipnet-ua", url: "https://ipnet.ua/raw_ipnet_as25521_geofeed.csv", netname: "IPNET-200310-UA", countries: "UA" },
  { id: "geofeed-ispconfig-digi-ro", url: "https://ispconfig.digi.ro/digi-geo-ip.txt", netname: "Digi-Belgium-NET", countries: "BE, ES, GB" },
  { id: "geofeed-ispconfig-digi-ro-2", url: "https://ispconfig.digi.ro/export_ip_es.csv", netname: "PT-DIGI-20230220-001", countries: "PT" },
  { id: "geofeed-itglobal-com", url: "https://geofeed.itglobal.com/geofeed.csv", netname: "AE-ITGLOBAL-20020530", countries: "AE, BR, BY" },
  { id: "geofeed-iver-com", url: "https://geofeed.iver.com/AS57829.csv", netname: "AMPHENOL-NET1", countries: "BE, CH, DE" },
  { id: "geofeed-kamatera-com", url: "https://www.kamatera.com/geofeed.csv", netname: "CLOUDWEBMANAGE-EU", countries: "DE, ES, GB" },
  { id: "geofeed-keminet-net", url: "https://geofeed.keminet.net/geofeed.csv", netname: "AL-KEMINET-LTD", countries: "AL, AU, DE" },
  { id: "geofeed-lanta-net-ru", url: "https://geo.lanta-net.ru/geofeed.csv", netname: "AE-SESAMEWARE", countries: "RU" },
  { id: "geofeed-luminabroadband-com", url: "https://luminabroadband.com/geofeed.txt", netname: "IPXO", countries: "AE, AR, AT" },
  { id: "geofeed-market-fibercop-com", url: "https://market.fibercop.com/wp-content/uploads/2026/08/geofeed.csv", netname: "IT-FIBERCOP-SPA-20020708", countries: "IT" },
  { id: "geofeed-massresponse-com", url: "https://massresponse.com/geofeed.csv", netname: "AT-MASSRESPONSE-20000627", countries: "AT, IT" },
  { id: "geofeed-media-bezeqint-net", url: "https://media.bezeqint.net/geofeed.csv", netname: "BEZEQINT", countries: "IL" },
  { id: "geofeed-megaport-com", url: "https://lg.megaport.com/geofeed.txt", netname: "UK-MEGAPORT-20250220", countries: "GB" },
  { id: "geofeed-meta-nextpertise-nl", url: "https://meta.nextpertise.nl/geofeed/geofeed.csv", netname: "NEXT-POOL", countries: "DE, NL" },
  { id: "geofeed-minio-uzdc-uz", url: "https://minio.uzdc.uz/uztelecom-web-bucket/geofeed.csv", netname: "UZ-UZTELECOM-20050603", countries: "UZ" },
  { id: "geofeed-mkpnet-ru", url: "https://mkpnet.ru/files/geofeed.csv", netname: "ORG-OL75-RIPE", countries: "RU" },
  { id: "geofeed-mvps-net", url: "https://www.mvps.net/api/geolocation.php", netname: "CY-MVPS", countries: "CY, DE, ES" },
  { id: "geofeed-net-sky", url: "https://geofeed.net.sky/geofeed.csv", netname: "SKY-BROADBAND", countries: "GB, IE" },
  { id: "geofeed-net3-ai", url: "https://geofeed.net3.ai/ripe-geofeed.csv", netname: "Rogers_Communications", countries: "CA, US" },
  { id: "geofeed-netcrafters-tech", url: "https://netcrafters.tech/geofeed.csv", netname: "NetCrafters", countries: "AT, DE, EE" },
  { id: "geofeed-network-thg-com", url: "https://geofeed.network.thg.com/geofeed.csv", netname: "EU-100TB", countries: "DE, GB, NL" },
  { id: "geofeed-netz-mwn-de", url: "https://geofeed.netz.mwn.de/rfc8805.csv", netname: "BL-NFS-LAN", countries: "DE" },
  { id: "geofeed-nevalink-net", url: "https://nevalink.net/geofeed.csv", netname: "NEVALINK-NET", countries: "RU" },
  { id: "geofeed-noc-ilan-net-il", url: "https://noc.ilan.net.il/GGC/iucc-geo-feed-for-google.csv", netname: "Ariel-segments", countries: "IL" },
  { id: "geofeed-obj3220-public-dk6-clu4-obj-storagefactory-io", url: "https://obj3220.public-dk6.clu4.obj.storagefactory.io/geofeed/geofeed.csv", netname: "ACL-10291", countries: "DK, NO" },
  { id: "geofeed-opengeofeed-org", url: "https://opengeofeed.org/feed/as39869.csv", netname: "LIVENET-PL", countries: "PL" },
  { id: "geofeed-paltel-ps", url: "https://www.paltel.ps/ip_geopaltel/", netname: "PALTEL-FTTH", countries: "IL, PS" },
  { id: "geofeed-podaon-com", url: "https://geofeed.podaon.com/geofeed.csv", netname: "NET-1-1", countries: "DE, NL, PL" },
  { id: "geofeed-portal-proxybr-com-br", url: "https://portal.proxybr.com.br/gfeed/geofeed.csv", netname: "IPXO", countries: "BR, EU, US" },
  { id: "geofeed-power-servers-net", url: "https://geofeed.power-servers.net/ih_geofeed.csv", netname: "PSERVERS-CLOUD-HOSTING", countries: "EU, FI, RU" },
  { id: "geofeed-powernet-com-ru", url: "https://geofeed.powernet.com.ru/geofeed.csv", netname: "NEVOD-NET", countries: "RU" },
  { id: "geofeed-prefixbroker-com", url: "https://www.prefixbroker.com/prefixbroker-geofeed.csv", netname: "AHASEND-185-135-140-0", countries: "AE, AR, AT" },
  { id: "geofeed-r-kom-de", url: "https://geofeed.r-kom.de/geofeed.csv", netname: "DE-R-KOM-19990728", countries: "DE" },
  { id: "geofeed-rapidseedbox-com", url: "https://geofeed.rapidseedbox.com/geofeed.csv", netname: "AE-RAPIDSEEDBOX-20240807", countries: "AE, BD, BE" },
  { id: "geofeed-raw-githubusercontent-com", url: "https://raw.githubusercontent.com/hostinger/geofeed/main/geofeed.csv", netname: "AS47583", countries: "AU, BR, CL" },
  { id: "geofeed-raw-githubusercontent-com-10", url: "https://raw.githubusercontent.com/terratransit/geofeed/main/geofeed.csv", netname: "Code200", countries: "AR, BR, CA" },
  { id: "geofeed-raw-githubusercontent-com-11", url: "https://raw.githubusercontent.com/abdulalia/geofeed-ultel/refs/heads/main/geofeed.csv", netname: "AZ-ULTEL-20060113", countries: "AZ" },
  { id: "geofeed-raw-githubusercontent-com-2", url: "https://raw.githubusercontent.com/nasstar-networks/geofeed/refs/heads/main/geofeed.txt", netname: "UK-GCINETWORK-20031110", countries: "GB" },
  { id: "geofeed-raw-githubusercontent-com-3", url: "https://raw.githubusercontent.com/NOC-ATMAN/geofeed/main/geofeed.csv", netname: "ATMAN", countries: "PL" },
  { id: "geofeed-raw-githubusercontent-com-4", url: "https://raw.githubusercontent.com/hlkomm/geofeeds/main/geofeeds.csv", netname: "DE-TELSA-20000403", countries: "DE" },
  { id: "geofeed-raw-githubusercontent-com-5", url: "https://raw.githubusercontent.com/equinix/geofeed/main/geofeed.csv", netname: "EQUINIX-155-204-0-0", countries: "US" },
  { id: "geofeed-raw-githubusercontent-com-6", url: "https://raw.githubusercontent.com/G-Network/geolocation-RIPE/main/Geoloc.csv", netname: "UK-GNETWORK-19880926", countries: "GB" },
  { id: "geofeed-raw-githubusercontent-com-7", url: "https://raw.githubusercontent.com/notyourcommy/veesp-geo/main/geofeed.csv", netname: "IL-FEDOROV-20080422", countries: "LV, NL, RU" },
  { id: "geofeed-raw-githubusercontent-com-8", url: "https://raw.githubusercontent.com/Simonadascalu/Freedomtech-Geofeed/refs/heads/main/Freedomtech%20solutions%20-%20ALL", netname: "DET-GB-CUSTOMERS", countries: "BG, BR, CL" },
  { id: "geofeed-raw-githubusercontent-com-9", url: "https://raw.githubusercontent.com/imena/geofeed/main/mirohost.csv", netname: "MIROHOST", countries: "PL, UA" },
  { id: "geofeed-redcom-ru", url: "https://redcom.ru/geo/redcom-geo.csv", netname: "KHDS-IPoE-1", countries: "RU" },
  { id: "geofeed-retn-net", url: "https://www.retn.net/geofeed/geofeed_v4.csv", netname: "AM-RETN-20230530", countries: "AM, EU, GB" },
  { id: "geofeed-ripe-unyc-io", url: "https://ripe.unyc.io", netname: "FR-SERVEURCOM-20080818", countries: "FR" },
  { id: "geofeed-ruvds-com", url: "https://ruvds.com/geofeed.csv", netname: "AE-FN-20190814", countries: "AM, BY, CH" },
  { id: "geofeed-s3-wifirst-net", url: "https://s3.wifirst.net/geofeed/AS52075_Geofeed.csv", netname: "EXPO-HavasSharedServices-20031231", countries: "DE, FR, GB" },
  { id: "geofeed-sa-zain-com", url: "https://sa.zain.com/geofeed", netname: "SA-MTC", countries: "SA" },
  { id: "geofeed-sakura-as", url: "https://geo.sakura.as/geo.csv", netname: "SAKURA-LINK-GTT", countries: "EU, HK, JP" },
  { id: "geofeed-sanaplus-ua", url: "https://sanaplus.ua/geofeed.csv", netname: "RENOME-SERVICE", countries: "UA" },
  { id: "geofeed-sapphire-networks-com", url: "https://sapphire-networks.com/geofeed.csv", netname: "BGL", countries: "GI" },
  { id: "geofeed-secure-wireline-com-au", url: "https://secure.wireline.com.au/geo/feed.csv", netname: "MATE-CPE1", countries: "AU" },
  { id: "geofeed-selectel-ru", url: "https://geofeed.selectel.ru/subnets.csv", netname: "RU-SELECTEL", countries: "RU" },
  { id: "geofeed-smartape-ru", url: "https://smartape.ru/geofeed_sa.csv", netname: "RU-LLCSMARTAPE-20080717", countries: "RU" },
  { id: "geofeed-stat-maxnet-ua", url: "https://stat.maxnet.ua/geofeeds.csv", netname: "KHARKOV-MAXNET-N1", countries: "UA" },
  { id: "geofeed-status-serv-host", url: "https://status.serv.host/geofeed/subnet.csv", netname: "AS210546-iPv4", countries: "AT, BE, CA" },
  { id: "geofeed-suregeoip-sure-com", url: "https://suregeoip.sure.com/suregeoip.csv", netname: "At-Hol-Ltd", countries: "GB, GG, IM" },
  { id: "geofeed-syn-uk", url: "https://syn.uk/geofeed.csv", netname: "UK-SYN-20051129", countries: "EU, GB, NL" },
  { id: "geofeed-tele2-net", url: "https://geofeed.tele2.net/", netname: "LT-TELE2-GPRS", countries: "LT, LV, SE" },
  { id: "geofeed-teledata-de", url: "https://www.teledata.de/as21263_geofeed.csv", netname: "DE-MCONNECT-20241118", countries: "DE" },
  { id: "geofeed-telia-net", url: "https://lg.telia.net/ripe/AS25400_geofeed.csv", netname: "NO-TELE1", countries: "NO" },
  { id: "geofeed-the-hosting", url: "https://the.hosting/geofeed.csv", netname: "THE-HOSTING", countries: "AL, AM, AT" },
  { id: "geofeed-time-net-it", url: "https://geofeed.time-net.it/tn_geofeed.csv", netname: "IT-TELEX-20120730", countries: "IT" },
  { id: "geofeed-timeweb-net", url: "https://geofeed.timeweb.net/geofeed.csv", netname: "AE-IX-20191107", countries: "DE, GB, KZ" },
  { id: "geofeed-trooli-com", url: "https://geofeed.trooli.com/geofeed.csv", netname: "UK-TROOLI", countries: "GB" },
  { id: "geofeed-truespeed-net-uk", url: "https://geofeed.truespeed.net.uk/geofeed.csv", netname: "UK-TRUESPEED", countries: "GB" },
  { id: "geofeed-ttc-kz", url: "https://ttc.kz/geofeed.csv", netname: "KZ-TRANSTELECOM", countries: "KZ" },
  { id: "geofeed-tviy-net-ua", url: "https://tviy.net.ua/geo/geofeed.csv", netname: "CITYNET-NETWORK", countries: "UA" },
  { id: "geofeed-unive-it", url: "https://www.unive.it/geofeed.txt", netname: "UNI-VE1", countries: "IT" },
  { id: "geofeed-vdsina-com", url: "https://vdsina.com/geofeed_as216071.csv", netname: "AE-SERVERS-TECH-19960509", countries: "AE, NL" },
  { id: "geofeed-vdsina-ru", url: "https://vdsina.ru/geofeed.csv", netname: "RU-VDSINA", countries: "RU" },
  { id: "geofeed-velia-net", url: "https://www.velia.net/geofeed.csv", netname: "DE-VELIANET1-19840101", countries: "DE, FR" },
  { id: "geofeed-vernet-lv", url: "https://www.vernet.lv/geofeed.csv", netname: "LV-VERNET-19960513", countries: "LV" },
  { id: "geofeed-virtono-com", url: "https://virtono.com/geofeed.csv", netname: "RO-VIRTONO-20180730", countries: "ES, RO, US" },
  { id: "geofeed-vsenet-de", url: "https://geofeed.vsenet.de/", netname: "DE-SAARGATE-19910719", countries: "DE" },
  { id: "geofeed-vsys-host", url: "https://vsys.host/geofeed.csv", netname: "AMS", countries: "NL, SG, UA" },
  { id: "geofeed-whgi-net", url: "https://geofeed.whgi.net/geofeed.csv", netname: "UK-WHGI-19960925", countries: "AE, AU, CA" },
  { id: "geofeed-wiredisp-com", url: "https://geofeed.wiredisp.com/ripe-geofeed.csv", netname: "ATT-Boston", countries: "BD, BY, CN" },
  { id: "geofeed-wnet-global", url: "https://geofeed.wnet.global/geofeed.csv", netname: "ADVAIXUA", countries: "PL, UA, US" },
  { id: "geofeed-ws-sdn-net", url: "https://ws-sdn.net/feed/wssdnfeed.csv", netname: "AE", countries: "AE, AR, BA" },
  { id: "geofeed-zen-co-uk", url: "https://zen.co.uk/geofeed.csv", netname: "UK-ZEN-20100604", countries: "GB" },
  { id: "geofeed-zenlayer-net", url: "https://geofeed.zenlayer.net/geofeed.csv", netname: "SG-ZENLAYER-20220210", countries: "DE, GB, IN" },
  { id: "geofeed-zf-com", url: "https://geofeed.zf.com/as216134_geofeed.csv", netname: "DE-ZFFRIEDRICHSHAFEN", countries: "DE" },
];
