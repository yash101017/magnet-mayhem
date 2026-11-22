'use strict'
const first = ('Aiden Amelia Aria Asher Ava Avery Bailey Blake Brooke Caleb Casey Chloe Clara Cody Cole Cora Daisy Devon Dylan Eden Eli Ella Emery Ethan Eva Fiona Finn Freya Grant Hana Harper Hazel Henry Iris Isla Ivy Jack Jade Jamie Jett Jordan Jude Kai Kara Kira Kyla Lana Leah Leo Liam Lily Logan Luca Luna Mae Maya Mia Milo Mira Morgan Nia Nico Nina Noah Nora Owen Paige Quinn Rae Remy Riley Robin Rosa Rowan Ruby Ryan Sage Sam Sawyer Sienna Skye Sofia Talia Taylor Theo Toby Tyler Vera Violet Wade Willa Willow Wyatt Yara Zane Zara Zoe Zora Amos Tess').split(' ')
const last = ('Alder Ash Bay Birch Bloom Brooks Cedar Chase Clay Cole Cove Cruz Dale Dean Drake Dunn East Ellis Finch Flynn Frost Gale Glenn Gray Green Hale Hart Hayes Heath Hill Holt Lane Lee Lowe Marsh Miles Moon Nash North Oak Page Park Pike Reed Ridge Rose Sage Stone Vale West').split(' ')
const names = first.flatMap(given => last.map(family => given + ' ' + family))
if(names.length!==5000||new Set(names).size!==5000)throw new Error('Expected exactly 5,000 different opponent names.')
module.exports=names

