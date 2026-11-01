/**
 * 坐标系转换
 *
 * 项目内部统一使用 WGS-84（GPS 原始坐标），地图底图、OSRM、卫星影像都基于它。
 * 但国内地图服务（高德/腾讯/百度）返回的是加密偏移坐标：
 *   GCJ-02  国测局坐标，高德/腾讯使用
 *   BD-09   百度在 GCJ-02 上再偏移一次
 *
 * 只在「调用商业地理编码」这一层做转换，进出都保持 WGS-84，
 * 避免偏移量扩散到整个应用。
 */

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

/** 中国大陆范围外不做偏移（港澳台和境外服务本身就用 WGS-84） */
function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS-84 → GCJ-02 */
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lat + dLat, lng + dLng];
}

/**
 * GCJ-02 → WGS-84
 * 正向公式没有解析反函数，用三轮迭代逼近，误差在 1 米以内。
 */
export function gcj02ToWgs84(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  let wgsLat = lat;
  let wgsLng = lng;
  for (let i = 0; i < 3; i += 1) {
    const [gLat, gLng] = wgs84ToGcj02(wgsLat, wgsLng);
    wgsLat += lat - gLat;
    wgsLng += lng - gLng;
  }
  return [wgsLat, wgsLng];
}

/** 百度 BD-09 → WGS-84（先解百度偏移，再解国测局偏移） */
export function bd09ToWgs84(lat: number, lng: number): [number, number] {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * (PI * 3000.0) / 180.0);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * (PI * 3000.0) / 180.0);
  const gcjLng = z * Math.cos(theta);
  const gcjLat = z * Math.sin(theta);
  return gcj02ToWgs84(gcjLat, gcjLng);
}
