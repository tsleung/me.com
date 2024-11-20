# me.com

This is the home page of your new Observable Framework app! YAY!


```js
const chart = display(await vl.render({
  spec: {
    width: 640,
    height: 250,
    data: {url: "https://vega.github.io/vega-lite/data/cars.json"},
    mark: "bar",
    encoding: {
      x: {field: "Cylinders"},
      y: {aggregate: "count", title: "Number of cars"}
    }
  }
}));

const canvas = chart.firstChild;
canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
canvas.style.maxWidth = "100%";
canvas.style.height = "auto";
```

```js
const random = d3.randomLcg(42);
const x = Array.from({length: 500}, random);
const y = Array.from({length: 500}, random);
const chart = Plot.voronoi(x, {x, y, fill: x}).plot({nice: true});

display(chart);
```


```js
// let rand_dataset = penguins
console.log('penguins', penguins)
const chart = Plot.plot({
  grid: true,
  inset: 10,
  aspectRatio: 1,
  color: {legend: true},
  marks: [
    Plot.frame(),
    Plot.dot(penguins, {x: "culmen_length_mm", y: "culmen_depth_mm", stroke: "species"})
  ]
})

display(chart)

```

For more, see <https://observablehq.com/framework/getting-started>.
