from flask import Flask, request, jsonify
from flask_cors import CORS
import rasterio
from rasterio.mask import mask
from shapely.geometry import box, mapping
import numpy as np

app = Flask(__name__)
CORS(app)  # Allow requests from the frontend

TIF_PATH = "data/landscan-india-2024.tif"

POLLUTANTS = ['spm', 'so2', 'no2', 'co']

def num_monitors_cpcb(pollutant, population):
    if pollutant == 'spm':
        num_station = [4]
        if 1000000 < population:
            num_station.append(np.floor(4 + 0.6*900000/100000)+1)
        else:
            num_station.append(np.floor(4 + 0.6*(population-100000)/100000)+1)
        if 5000000 < population:
            num_station.append(np.floor(7.5 + 0.25*4000000/100000)+1)
        else:
            num_station.append(np.floor(7.5 + 0.25*(population-1000000)/100000)+1)
        if 5000000 < population:
            num_station.append(np.floor(12 + 0.16*(population-5000000)/100000)+1)

    if pollutant == 'so2':
        num_station = [3]
        if 1000000 < population:
            num_station.append(np.floor(2.5 + 0.5*900000/100000)+1)
        else:
            num_station.append(np.floor(2.5 + 0.5*(population-100000)/100000)+1)
        if 10000000 < population:
            num_station.append(np.floor(6 + 0.15*9000000/100000)+1)
        else:
            num_station.append(np.floor(6 + 0.15*(population-1000000)/100000)+1)
        if 10000000 < population:
            num_station.append(20)

    if pollutant == 'no2':
        num_station = [4]
        if 1000000 < population:
            num_station.append(np.floor(4 + 0.6*900000/100000)+1)
        else:
            num_station.append(np.floor(4 + 0.6*(population-100000)/100000)+1)
        if 1000000 < population:
            num_station.append(10)

    if pollutant == 'co':
        num_station = [1]
        if 5000000 < population:
            num_station.append(np.floor(1 + 0.15*4900000/100000)+1)
        else:
            num_station.append(np.floor(1 + 0.15*(population-100000)/100000)+1)
        if 5000000 < population:
            num_station.append(np.floor(6 + 0.05*(population-5000000)/100000)+1)

    return int(sum(num_station))


@app.route("/population", methods=["POST"])
def get_population():
    """
    Accepts a bounding box as JSON:
      { "south": float, "west": float, "north": float, "east": float }
    Returns estimated population within that bbox.
    """
    data = request.get_json()

    try:
        south = float(data["south"])
        west  = float(data["west"])
        north = float(data["north"])
        east  = float(data["east"])
    except (KeyError, TypeError, ValueError) as e:
        return jsonify({"error": f"Invalid bbox parameters: {e}"}), 400

    # Build a shapely box from the bbox and convert to GeoJSON-style geometry
    bbox_geom = box(west, south, east, north)
    geojson_geom = [mapping(bbox_geom)]

    try:
        with rasterio.open(TIF_PATH) as src:
            # Reproject geometry if the raster is not in WGS84
            if src.crs.to_epsg() != 4326:
                from pyproj import Transformer
                from shapely.ops import transform as shp_transform

                transformer = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True)
                bbox_geom_proj = shp_transform(transformer.transform, bbox_geom)
                geojson_geom = [mapping(bbox_geom_proj)]

            out_image, _ = mask(src, geojson_geom, crop=True)

    except Exception as e:
        return jsonify({"error": f"Rasterio error: {e}"}), 500

    # Replace nodata / negative values with NaN, then sum
    population_data = np.where(out_image < 0, np.nan, out_image.astype(float))
    total_population = int(np.nansum(population_data))
    population_millions = round(total_population / 1_000_000, 4)

    monitors = {p: num_monitors_cpcb(p, total_population) for p in POLLUTANTS}

    return jsonify({
        "population": total_population,
        "population_millions": population_millions,
        "monitors_required": monitors,
        "bbox": {
            "south": south, "west": west,
            "north": north, "east": east
        }
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000)